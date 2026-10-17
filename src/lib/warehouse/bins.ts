import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { BIN_CODE_PREFIX, codeNumber, formatBinCode, formatItemCode, normalizeCode } from "./codes";
import { assertShelfTakesBins } from "./shelves";
import type { ItemLocation } from "./types";

// Every change to what's in a bin goes through this file, so the BinMove log
// and the "bin is empty, reuse it" state can't drift from the contents.
// Functions that take a `tx` must run inside prisma.$transaction so the
// change and its log row land together.
//
// Lock order (several people pick, sell, fill and combine at once):
//   1. per-bin locks (lockBins), always in bin-code order
//   2. then any Item row lock (FOR UPDATE)
//   3. then BinContent / Bin rows
// Every writer of BinContent takes the bin locks first, so a sale or pick
// that arrives while two bins are being combined waits for the combine to
// finish and then takes the unit from wherever it ended up, instead of the
// two waiting on each other (a deadlock) or the unit being counted twice.

type Tx = Prisma.TransactionClient;

export class WarehouseError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "WarehouseError";
  }
}

// Next item code (ES000123). Safe with any number of stations saving at once.
export async function nextItemCode(tx: Tx | typeof prisma = prisma): Promise<string> {
  const row = await tx.labelCounter.create({ data: {} });
  return formatItemCode(row.id);
}

// Makes `count` new bins numbered after the highest existing one.
export async function createBins(count: number): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new WarehouseError("Make between 1 and 500 bins at a time.");
  }
  return prisma.$transaction(async (tx) => {
    // Serialize concurrent "make bins" clicks so numbers never collide.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('warehouse_create_bins'))`;
    // Numeric max, not a text sort: "BN10000" sorts before "BN9999" as text.
    const existing = await tx.bin.findMany({ select: { code: true } });
    const start = Math.max(0, ...existing.map((b) => codeNumber(b.code, BIN_CODE_PREFIX) ?? 0)) + 1;
    const codes = Array.from({ length: count }, (_, i) => formatBinCode(start + i));
    await tx.bin.createMany({ data: codes.map((code) => ({ code })) });
    return codes;
  });
}

// The per-bin lock every BinContent writer takes first. Postgres advisory
// locks held until the transaction ends; taking one twice in the same
// transaction is fine. Sorted so two transactions needing the same bins
// always queue in the same order.
export async function lockBins(tx: Tx, codes: string[]): Promise<void> {
  for (const code of [...new Set(codes.map(normalizeCode))].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`warehouse_bin:${code}`}))`;
  }
}

export async function findBin(tx: Tx | typeof prisma, rawCode: string) {
  const code = normalizeCode(rawCode);
  const bin = await tx.bin.findUnique({ where: { code } });
  if (!bin) throw new WarehouseError(`No bin with code ${code}. Check the label or make the bin on the Bins page.`, 404);
  return bin;
}

// Puts `units` of an item into a bin (adds to what's already there). If the
// bin was empty and still marked as on a shelf, it has physically come back
// to a station, so it's unshelved.
export async function placeInBin(
  tx: Tx,
  args: { itemId: string; binCode: string; units: number; by: string | null; note?: string }
): Promise<void> {
  if (!Number.isInteger(args.units) || args.units < 1) throw new WarehouseError("Units must be at least 1.");
  await lockBins(tx, [args.binCode]);
  const bin = await findBin(tx, args.binCode);
  const existingCount = await tx.binContent.count({ where: { binId: bin.id } });
  if (existingCount === 0 && bin.shelfLabel) {
    await tx.bin.update({ where: { id: bin.id }, data: { shelfLabel: null, shelvedAt: null, shelvedBy: null } });
    await tx.binMove.create({
      data: { kind: "unshelve", fromBinCode: bin.code, shelfLabel: bin.shelfLabel, note: "Empty bin reused", by: args.by },
    });
  }
  await tx.binContent.upsert({
    where: { binId_itemId: { binId: bin.id, itemId: args.itemId } },
    create: { binId: bin.id, itemId: args.itemId, units: args.units },
    update: { units: { increment: args.units } },
  });
  if (bin.emptiedAt) await tx.bin.update({ where: { id: bin.id }, data: { emptiedAt: null } });
  await tx.binMove.create({
    data: { kind: "place", itemId: args.itemId, toBinCode: bin.code, units: args.units, note: args.note, by: args.by },
  });
}

// Takes units of an item out of its bins (picked for an order, sold off the
// shelf, pulled for expiry, written off). Takes from `preferBinCode` first,
// then the rest, oldest placement first. Locks the rows so two people
// picking the same item can't both take the last unit. Returns how many
// units were actually taken from each bin; less than asked is normal for
// items listed before warehouse mode (they're in no bin).
export async function removeUnits(
  tx: Tx,
  args: {
    itemId: string;
    units: number;
    kind: "pick" | "sale" | "pull" | "adjust";
    by: string | null;
    preferBinCode?: string | null;
    note?: string;
  }
): Promise<{ binCode: string; units: number }[]> {
  if (args.units < 1) return [];
  // Bin locks first (see the lock order at the top). The bins are read,
  // locked, then read again: if a combine was moving this item, the lock
  // waited for it, and the item may now be in a bin we haven't locked yet.
  const locked = new Set<string>();
  for (let round = 0; round < 5; round++) {
    const holding = await tx.$queryRaw<{ code: string }[]>`
      SELECT DISTINCT b.code FROM "BinContent" bc JOIN "Bin" b ON b.id = bc."binId" WHERE bc."itemId" = ${args.itemId}`;
    const missing = holding.map((h) => h.code).filter((c) => !locked.has(c));
    if (missing.length === 0) break;
    await lockBins(tx, missing);
    missing.forEach((c) => locked.add(c));
  }
  const rows = await tx.$queryRaw<{ id: string; binId: string; units: number; code: string }[]>`
    SELECT bc.id, bc."binId", bc.units, b.code
    FROM "BinContent" bc JOIN "Bin" b ON b.id = bc."binId"
    WHERE bc."itemId" = ${args.itemId}
    ORDER BY bc."placedAt" ASC
    FOR UPDATE OF bc`;
  const preferred = args.preferBinCode ? normalizeCode(args.preferBinCode) : null;
  rows.sort((a, b) => Number(b.code === preferred) - Number(a.code === preferred));

  let left = args.units;
  const taken: { binCode: string; units: number }[] = [];
  for (const row of rows) {
    if (left === 0) break;
    const n = Math.min(left, row.units);
    left -= n;
    taken.push({ binCode: row.code, units: n });
    if (n === row.units) await tx.binContent.delete({ where: { id: row.id } });
    else await tx.binContent.update({ where: { id: row.id }, data: { units: { decrement: n } } });
    await tx.binMove.create({
      data: { kind: args.kind, itemId: args.itemId, fromBinCode: row.code, units: n, note: args.note, by: args.by },
    });
    await markEmptyIfEmpty(tx, row.binId);
  }
  return taken;
}

type RemovalKind = Parameters<typeof removeUnits>[1]["kind"];

// A bin update that still failed after retries is written down as a BinMove
// of this kind (units null = everything still in bins), with the original
// kind in the note as "[sale] ...", and applied later by
// applyPendingRemovals. Once applied it becomes PENDING_APPLIED; the real
// removal is logged next to it as usual.
export const PENDING_REMOVE = "pending_remove";
const PENDING_APPLIED = "pending_applied";

// Bin bookkeeping after stock has already left for real (an in-person
// sale pushed to eBay, a stock removal, a pull): runs in its own
// transaction AFTER the sale/adjustment is saved, and never throws. The
// money and stock record comes first. A combine on the same bin can hold
// it up for a while (up to 30s), so this waits, and retries a few times if
// it still loses out. If it never gets through, the removal is recorded
// as pending and settled on the next bin change for that item, the next
// combine, or the next time the Bins page loads. units "all" =
// everything still in bins.
export async function removeUnitsBestEffort(
  args: Omit<Parameters<typeof removeUnits>[1], "units"> & { units: number | "all" }
): Promise<{ taken: { binCode: string; units: number }[]; binsUpdated: boolean }> {
  await applyPendingRemovals(args.itemId);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 500));
    try {
      const taken = await prisma.$transaction((tx) => removeResolved(tx, args), { timeout: 40_000, maxWait: 10_000 });
      return { taken, binsUpdated: true };
    } catch (e) {
      lastError = e;
    }
  }
  const reason = lastError instanceof Error ? lastError.message.slice(0, 300) : String(lastError);
  console.error(
    `[warehouse] Couldn't take ${args.units} unit(s) of item ${args.itemId} out of its bins (${args.kind}) after 3 tries. ` +
      "The sale/adjustment itself was saved; recorded as a pending bin removal to apply later.",
    lastError
  );
  try {
    await prisma.binMove.create({
      data: {
        kind: PENDING_REMOVE,
        itemId: args.itemId,
        units: args.units === "all" ? null : args.units,
        fromBinCode: args.preferBinCode ? normalizeCode(args.preferBinCode) : null,
        note: `[${args.kind}] ${args.note ?? ""} (bins busy: ${reason})`.slice(0, 1000),
        by: args.by,
      },
    });
  } catch (e) {
    console.error(`[warehouse] Couldn't even record the pending bin removal for item ${args.itemId}.`, e);
  }
  return { taken: [], binsUpdated: false };
}

async function removeResolved(
  tx: Tx,
  args: Omit<Parameters<typeof removeUnits>[1], "units"> & { units: number | "all" }
) {
  const units =
    args.units === "all"
      ? ((await tx.binContent.aggregate({ where: { itemId: args.itemId }, _sum: { units: true } }))._sum.units ?? 0)
      : args.units;
  return removeUnits(tx, { ...args, units });
}

// Settles pending bin removals (all of them, or one item's). Each one is
// claimed and applied in the same small transaction, so two callers can't
// both apply it, and a failure leaves it pending for next time. Never
// throws. Returns how many are still pending.
export async function applyPendingRemovals(itemId?: string): Promise<number> {
  try {
    const pending = await prisma.binMove.findMany({
      where: { kind: PENDING_REMOVE, ...(itemId ? { itemId } : {}) },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    for (const p of pending) {
      if (!p.itemId) continue;
      const kind = (/^\[(pick|sale|pull|adjust)\]/.exec(p.note ?? "")?.[1] ?? "adjust") as RemovalKind;
      try {
        await prisma.$transaction(
          async (tx) => {
            const claimed = await tx.binMove.updateMany({
              where: { id: p.id, kind: PENDING_REMOVE },
              data: { kind: PENDING_APPLIED },
            });
            if (claimed.count === 0) return; // someone else just applied it
            await removeResolved(tx, {
              itemId: p.itemId!,
              units: p.units ?? "all",
              kind,
              by: p.by,
              preferBinCode: p.fromBinCode,
              note: "Applied a bin removal that was pending",
            });
          },
          { timeout: 40_000, maxWait: 10_000 }
        );
      } catch (e) {
        console.error(`[warehouse] Pending bin removal ${p.id} still couldn't be applied; will retry.`, e);
      }
    }
    return prisma.binMove.count({ where: { kind: PENDING_REMOVE, ...(itemId ? { itemId } : {}) } });
  } catch (e) {
    console.error("[warehouse] Couldn't check pending bin removals.", e);
    return 0;
  }
}

// Moves everything (or only `itemIds`) from one bin to another: merging two
// half-empty bins, or consolidating leftovers so a bin frees up.
// unshelveEmptiedFrom: the source bin came off its shelf to be emptied, so
// once it's empty it's in someone's hands, not on the shelf (the Bins
// page's Combine sets this).
export async function moveBinContents(args: {
  fromBinCode: string;
  toBinCode: string;
  itemIds?: string[];
  by: string | null;
  unshelveEmptiedFrom?: boolean;
}): Promise<{ itemsMoved: number; unitsMoved: number; fromEmpty: boolean }> {
  // Any bin count still owed from an earlier failed update gets settled
  // first, so the combine moves the true contents.
  await applyPendingRemovals();
  return prisma.$transaction(async (tx) => {
    const from = await findBin(tx, args.fromBinCode);
    const to = await findBin(tx, args.toBinCode);
    if (from.id === to.id) throw new WarehouseError("That's the same bin twice.");
    // Two people combining the same bins at once (A into B while someone
    // does B into A, or both emptying A) would otherwise each read the
    // same rows and move the units twice. A per-bin lock, always taken in
    // code order so the two can't wait on each other forever, makes the
    // second one wait and then see what's really left.
    await lockBins(tx, [from.code, to.code]);
    // Re-read now that nobody else can change these two bins.
    const fromNow = await tx.bin.findUniqueOrThrow({ where: { id: from.id } });
    const toNow = await tx.bin.findUniqueOrThrow({ where: { id: to.id } });
    // Row locks too, so a pick (removeUnits) can't take a unit out of a row
    // between reading it here and moving it.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "BinContent" WHERE "binId" = ${from.id} FOR UPDATE`;
    const rows = await tx.binContent.findMany({
      where: {
        id: { in: locked.map((r) => r.id) },
        ...(args.itemIds ? { itemId: { in: args.itemIds } } : {}),
      },
    });
    if (rows.length === 0) throw new WarehouseError(`Nothing to move in ${from.code}.`);
    const kind = args.itemIds ? "transfer" : "merge";
    // A handful of statements however many items move (a full bin is
    // dozens): one row at a time took ~8s for 40 items over the network
    // and ran out the transaction's clock.
    const already = new Set(
      (
        await tx.binContent.findMany({
          where: { binId: to.id, itemId: { in: rows.map((r) => r.itemId) } },
          select: { itemId: true },
        })
      ).map((r) => r.itemId)
    );
    await tx.binContent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    const adds = rows.filter((r) => already.has(r.itemId));
    if (adds.length > 0) {
      await tx.$executeRaw`
        UPDATE "BinContent" t SET units = t.units + v.units, "updatedAt" = now()
        FROM UNNEST(${adds.map((r) => r.itemId)}::text[], ${adds.map((r) => r.units)}::int[]) AS v("itemId", units)
        WHERE t."binId" = ${to.id} AND t."itemId" = v."itemId"`;
    }
    const fresh = rows.filter((r) => !already.has(r.itemId));
    if (fresh.length > 0) {
      await tx.binContent.createMany({
        data: fresh.map((r) => ({ binId: to.id, itemId: r.itemId, units: r.units, placedAt: r.placedAt })),
      });
    }
    await tx.binMove.createMany({
      data: rows.map((r) => ({ kind, itemId: r.itemId, fromBinCode: from.code, toBinCode: to.code, units: r.units, by: args.by })),
    });
    const unitsMoved = rows.reduce((sum, r) => sum + r.units, 0);
    if (toNow.emptiedAt) await tx.bin.update({ where: { id: to.id }, data: { emptiedAt: null } });
    const fromEmpty = await markEmptyIfEmpty(tx, from.id);
    if (fromEmpty && args.unshelveEmptiedFrom && fromNow.shelfLabel) {
      await tx.bin.update({ where: { id: from.id }, data: { shelfLabel: null, shelvedAt: null, shelvedBy: null } });
      await tx.binMove.create({
        data: { kind: "unshelve", fromBinCode: from.code, shelfLabel: fromNow.shelfLabel, note: "Emptied by combine", by: args.by },
      });
    }
    return { itemsMoved: rows.length, unitsMoved, fromEmpty };
  }, { timeout: 30_000, maxWait: 10_000 });
}

// Records which shelf a bin is on (or null to take it off). Shelving a bin
// nobody tapped "Close bin" on closes it: it's on a shelf, so it's done
// filling. Taking a bin off a shelf leaves it closed (ready to shelve).
// A shelf still holding old-system items (listed before warehouse mode)
// refuses bins until it's empty and confirmed (see shelves.ts).
export async function shelveBin(args: { binCode: string; shelfLabel: string | null; by: string | null }) {
  return prisma.$transaction(async (tx) => {
    await lockBins(tx, [args.binCode]);
    const bin = await findBin(tx, args.binCode);
    let shelfLabel: string | null = null;
    if (args.shelfLabel) {
      const shelf = await tx.shelfLocation.findFirst({
        where: { label: { equals: args.shelfLabel.trim(), mode: "insensitive" } },
      });
      if (!shelf) throw new WarehouseError(`No shelf called "${args.shelfLabel.trim()}". Add it in Settings first.`, 404);
      // Same lock as confirm/undo, so an undo can't slip in mid-shelve.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`warehouse_shelf:${shelf.label}`}))`;
      await assertShelfTakesBins(tx, shelf.label);
      shelfLabel = shelf.label;
    }
    const autoClose = shelfLabel != null && !bin.closedAt && (await tx.binContent.count({ where: { binId: bin.id } })) > 0;
    await tx.bin.update({
      where: { id: bin.id },
      data: {
        shelfLabel,
        shelvedAt: shelfLabel ? new Date() : null,
        shelvedBy: shelfLabel ? args.by : null,
        ...(autoClose ? { closedAt: new Date(), closedBy: args.by } : {}),
      },
    });
    await tx.binMove.create({
      data: {
        kind: shelfLabel ? "shelve" : "unshelve",
        fromBinCode: bin.code,
        shelfLabel: shelfLabel ?? bin.shelfLabel,
        by: args.by,
      },
    });
    return { binCode: bin.code, shelfLabel };
  });
}

// Takes units of an item out of one specific bin, never any other (the
// binning station's "Undo last scan": the unit came back out of the bin in
// hand). Logged as an "adjust" with the caller's note. Throws if that bin
// doesn't hold that many.
export async function takeFromBin(
  tx: Tx,
  args: { itemId: string; binCode: string; units: number; by: string | null; note: string }
): Promise<{ binEmpty: boolean }> {
  if (!Number.isInteger(args.units) || args.units < 1) throw new WarehouseError("Units must be at least 1.");
  await lockBins(tx, [args.binCode]);
  const bin = await findBin(tx, args.binCode);
  const [row] = await tx.$queryRaw<{ id: string; units: number }[]>`
    SELECT id, units FROM "BinContent" WHERE "binId" = ${bin.id} AND "itemId" = ${args.itemId} FOR UPDATE`;
  if (!row || row.units < args.units) throw new WarehouseError(`That item isn't in ${bin.code} anymore.`, 409);
  if (row.units === args.units) await tx.binContent.delete({ where: { id: row.id } });
  else await tx.binContent.update({ where: { id: row.id }, data: { units: { decrement: args.units } } });
  await tx.binMove.create({
    data: { kind: "adjust", itemId: args.itemId, fromBinCode: bin.code, units: args.units, note: args.note, by: args.by },
  });
  return { binEmpty: await markEmptyIfEmpty(tx, bin.id) };
}

async function markEmptyIfEmpty(tx: Tx, binId: string): Promise<boolean> {
  const left = await tx.binContent.count({ where: { binId } });
  if (left > 0) return false;
  // An empty bin is reusable, so it's no longer "closed" either.
  await tx.bin.update({ where: { id: binId }, data: { emptiedAt: new Date(), closedAt: null, closedBy: null } });
  return true;
}

// Where each item's units are. Items with no bins fall back to their old
// shelf location (listed before warehouse mode).
export async function getItemLocations(
  items: { id: string; shelfLocation: string | null }[]
): Promise<Map<string, ItemLocation>> {
  const contents = await prisma.binContent.findMany({
    where: { itemId: { in: items.map((i) => i.id) } },
    include: { bin: { select: { code: true, shelfLabel: true } } },
    orderBy: { placedAt: "asc" },
  });
  const map = new Map<string, ItemLocation>();
  for (const item of items) map.set(item.id, { bins: [], legacyShelf: item.shelfLocation || null });
  for (const c of contents) {
    map.get(c.itemId)?.bins.push({ binCode: c.bin.code, shelfLabel: c.bin.shelfLabel, units: c.units });
  }
  for (const loc of map.values()) if (loc.bins.length > 0) loc.legacyShelf = null;
  return map;
}
