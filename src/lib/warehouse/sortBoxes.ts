import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { upcMatchKeys } from "../upcMatch";
import { WarehouseError } from "./bins";
import { codeNumber, formatSortBoxCode, normalizeCode, SORT_BOX_CODE_PREFIX } from "./codes";

// Sort boxes (SortBox / SortBoxEntry). Cristian's flow (2026-10-18): the
// whole load is sorted into boxes before listing starts. The sorter scans a
// box to make it active and every "Good" goes into it; at the List page,
// scanning a product shows which boxes hold it and pulls every unit of it to
// the listing table. Since 2026-11-01 boxes are never reused (small space,
// Cristian): like dud boxes, the sorter starts a new box for the load at the
// sort station and it stays that load's box for good. Every change to sort
// box contents goes through this file.

type Tx = Prisma.TransactionClient;

// gatheredBy: who pulled this product's units out of the boxes most
// recently (the lister's helper on /gather, or the lister).
export type SortLocation = { boxCode: string; inBox: number; pulled: number; sorted: number; gatheredBy: string | null };

// Where units sorted on a no-box load (Manifest.sortWithoutBoxes) show up:
// a "box" called this on the List page.
export const NO_BOX = "Not boxed";

// Starts a new sort box for a load (next free code, SB0001...), tied to it
// from the start. Serialized so two sorters starting a box at once can't
// get the same code.
export async function startSortBox(args: { manifestId: string }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('warehouse_create_sort_boxes'))`;
    const existing = await tx.sortBox.findMany({ select: { code: true } });
    const next = Math.max(0, ...existing.map((b) => codeNumber(b.code, SORT_BOX_CODE_PREFIX) ?? 0)) + 1;
    return tx.sortBox.create({
      data: { code: formatSortBoxCode(next), manifestId: args.manifestId, assignedAt: new Date() },
    });
  });
}

export async function findSortBox(tx: Tx | typeof prisma, rawCode: string) {
  const code = normalizeCode(rawCode);
  const box = await tx.sortBox.findUnique({ where: { code } });
  if (!box) throw new WarehouseError(`No sort box with code ${code}. Check the label.`, 404);
  return box;
}

// Makes a box the sorter's active box for a load: only a box started for
// this load. A box of any other load is refused, even if it's empty now
// (boxes aren't reused). A box with no load is one of the bulk-made ones
// from before that rule (SB0011-SB0040, never used): retired 2026-11-01,
// kept on record only so their codes are never handed out again.
export async function activateSortBox(args: { boxCode: string; manifestId: string }) {
  const box = await findSortBox(prisma, args.boxCode);
  if (box.manifestId === args.manifestId) return { boxCode: box.code, reassigned: false };
  if (!box.manifestId) {
    throw new WarehouseError(`${box.code} is retired (an old unused box). Start a new sort box for this load.`, 409);
  }
  const other = await prisma.manifest.findUnique({ where: { id: box.manifestId }, select: { title: true } });
  throw new WarehouseError(
    `${box.code} belongs to "${other?.title ?? "another load"}". Sort boxes aren't reused: start a new one for this load.`,
    409
  );
}

// Logs good units into a box. upc should be the manifest line's UPC when the
// scan matched a line (so later lookups match the manifest exactly), or the
// scanned code when it isn't on the manifest (extra = true). boxCode null =
// a load sorted without boxes: counted in, no box.
export async function logSorted(args: {
  boxCode: string | null;
  manifestId: string;
  upc: string;
  quantity: number;
  extra: boolean;
  by: string | null;
}) {
  if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 10_000) {
    throw new WarehouseError("Quantity has to be a whole number, at least 1.");
  }
  return prisma.$transaction(async (tx) => {
    let boxId: string | null = null;
    if (args.boxCode == null) {
      const m = await tx.manifest.findUnique({ where: { id: args.manifestId }, select: { sortWithoutBoxes: true } });
      if (!m) throw new WarehouseError("That load doesn't exist anymore.", 404);
      if (!m.sortWithoutBoxes) throw new WarehouseError("This load uses sort boxes. Scan a sort box first.", 409);
    } else {
      const box = await findSortBox(tx, args.boxCode);
      await tx.$executeRaw`SELECT id FROM "SortBox" WHERE id = ${box.id} FOR UPDATE`;
      const fresh = await tx.sortBox.findUniqueOrThrow({ where: { id: box.id } });
      if (fresh.manifestId !== args.manifestId) {
        throw new WarehouseError(`${fresh.code} isn't this load's box. Scan it again to use it for this load.`, 409);
      }
      boxId = fresh.id;
    }
    return tx.sortBoxEntry.create({
      data: {
        boxId,
        manifestId: args.manifestId,
        upc: args.upc.trim(),
        quantity: args.quantity,
        extra: args.extra,
        recordedBy: args.by,
      },
    });
  });
}

// Undo a sort scan (wrong count, wrong box). Only before any of it was
// pulled to listing, since after that the units are on the listing table.
export async function undoSorted(entryId: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ pulledUnits: number }[]>`
      SELECT "pulledUnits" FROM "SortBoxEntry" WHERE id = ${entryId} FOR UPDATE`;
    if (rows.length === 0) throw new WarehouseError("That sort scan is already gone.", 404);
    if (rows[0].pulledUnits > 0) throw new WarehouseError("Some of these were already pulled to listing, so this can't be undone here.", 409);
    await tx.sortBoxEntry.delete({ where: { id: entryId } });
  });
}

// Entries of one product on one load, matched loosely (leading zeros, check
// digit) like the rest of the app, locked when inside a transaction that
// will change them.
async function productEntries(tx: Tx, manifestId: string, upc: string, lock: boolean) {
  const all = await tx.sortBoxEntry.findMany({
    where: { manifestId },
    include: { box: { select: { code: true } } },
    orderBy: { createdAt: "asc" },
  });
  const wanted = new Set(upcMatchKeys(upc));
  const matching = all.filter((e) => upcMatchKeys(e.upc).some((k) => wanted.has(k)));
  if (lock && matching.length > 0) {
    const ids = matching.map((e) => e.id);
    await tx.$queryRaw`SELECT id FROM "SortBoxEntry" WHERE id = ANY(${ids}::text[]) FOR UPDATE`;
    return tx.sortBoxEntry.findMany({
      where: { id: { in: ids } },
      include: { box: { select: { code: true } } },
      orderBy: { createdAt: "asc" },
    });
  }
  return matching;
}

function summarize(
  entries: { quantity: number; pulledUnits: number; pulledAt: Date | null; pulledBy: string | null; box: { code: string } | null }[]
): SortLocation[] {
  const byBox = new Map<string, SortLocation>();
  const lastPull = new Map<string, number>();
  for (const e of entries) {
    const code = e.box?.code ?? NO_BOX;
    const loc = byBox.get(code) ?? { boxCode: code, inBox: 0, pulled: 0, sorted: 0, gatheredBy: null };
    loc.sorted += e.quantity;
    loc.pulled += e.pulledUnits;
    loc.inBox += e.quantity - e.pulledUnits;
    if (e.pulledUnits > 0 && e.pulledAt && e.pulledAt.getTime() >= (lastPull.get(code) ?? 0)) {
      lastPull.set(code, e.pulledAt.getTime());
      loc.gatheredBy = e.pulledBy;
    }
    byBox.set(code, loc);
  }
  return [...byBox.values()].sort((a, b) => a.boxCode.localeCompare(b.boxCode));
}

// Where a product is: per box, units still in it / pulled / sorted. Empty
// array = nothing sorted for it on this load (sorting skipped, or a typo).
export async function sortLocations(manifestId: string, upc: string): Promise<SortLocation[]> {
  return summarize(await productEntries(prisma as unknown as Tx, manifestId, upc, false));
}

// The List page scanned this product: every unit still in a box is now at
// the listing table (Cristian's call: no per-box scanning for the helper).
// Returns what was pulled from which box, plus the full picture after.
export async function pullForListing(args: { manifestId: string; upc: string; by: string | null }) {
  return prisma.$transaction(async (tx) => {
    const entries = await productEntries(tx, args.manifestId, args.upc, true);
    const pulled: { boxCode: string; units: number }[] = [];
    const now = new Date();
    for (const e of entries) {
      const left = e.quantity - e.pulledUnits;
      if (left <= 0) continue;
      await tx.sortBoxEntry.update({
        where: { id: e.id },
        data: { pulledUnits: e.quantity, pulledAt: now, pulledBy: args.by },
      });
      const code = e.box?.code ?? NO_BOX;
      const prev = pulled.find((p) => p.boxCode === code);
      if (prev) prev.units += left;
      else pulled.push({ boxCode: code, units: left });
    }
    const after = await productEntries(tx, args.manifestId, args.upc, false);
    return { pulled, locations: summarize(after) };
  });
}

// "Left some behind": units of this product that were pulled but are still
// in a box. Lowers pulledUnits on that box's entries, newest first.
export async function putBack(args: { manifestId: string; upc: string; boxCode: string; units: number }) {
  if (!Number.isInteger(args.units) || args.units < 1) throw new WarehouseError("Units must be at least 1.");
  return prisma.$transaction(async (tx) => {
    const code = args.boxCode.trim() === NO_BOX ? NO_BOX : normalizeCode(args.boxCode);
    const entries = (await productEntries(tx, args.manifestId, args.upc, true)).filter((e) => (e.box?.code ?? NO_BOX) === code);
    const pulled = entries.reduce((sum, e) => sum + e.pulledUnits, 0);
    if (pulled < args.units) {
      throw new WarehouseError(`Only ${pulled} of this product were pulled from ${code}.`);
    }
    let left = args.units;
    for (const e of [...entries].reverse()) {
      if (left === 0) break;
      const n = Math.min(left, e.pulledUnits);
      if (n === 0) continue;
      await tx.sortBoxEntry.update({ where: { id: e.id }, data: { pulledUnits: { decrement: n } } });
      left -= n;
    }
    const after = await productEntries(tx, args.manifestId, args.upc, false);
    return { locations: summarize(after) };
  });
}

// Lister's helper (/gather, Cristian 2026-11-01): loads that still have
// units sitting in sort boxes, so the helper's page can pick the load on
// its own when there's only one. Not-boxed loads count too (same as the
// List page treats them).
export async function loadsToGather(): Promise<{ manifestId: string; title: string; products: number; units: number }[]> {
  const rows = await prisma.$queryRaw<{ manifestId: string; products: number; units: number }[]>`
    SELECT "manifestId", COUNT(DISTINCT upc)::int AS products, SUM(quantity - "pulledUnits")::int AS units
    FROM "SortBoxEntry"
    WHERE quantity > "pulledUnits"
    GROUP BY "manifestId"`;
  if (rows.length === 0) return [];
  const titles = await prisma.manifest.findMany({
    where: { id: { in: rows.map((r) => r.manifestId) } },
    select: { id: true, title: true },
  });
  const titleOf = new Map(titles.map((m) => [m.id, m.title]));
  return rows
    .map((r) => ({ ...r, title: titleOf.get(r.manifestId) ?? "Untitled load" }))
    .sort((a, b) => b.units - a.units);
}

// What's still in the boxes for one load, box by box, so the helper knows
// which boxes still need emptying. Units of every product, not just one.
export async function boxesLeft(manifestId: string): Promise<{ boxCode: string; products: number; units: number }[]> {
  const entries = await prisma.sortBoxEntry.findMany({
    where: { manifestId },
    select: { upc: true, quantity: true, pulledUnits: true, box: { select: { code: true } } },
  });
  const byBox = new Map<string, { units: number; upcs: Set<string> }>();
  for (const e of entries) {
    const left = e.quantity - e.pulledUnits;
    if (left <= 0) continue;
    const code = e.box?.code ?? NO_BOX;
    const b = byBox.get(code) ?? { units: 0, upcs: new Set<string>() };
    b.units += left;
    b.upcs.add(e.upc);
    byBox.set(code, b);
  }
  return [...byBox.entries()]
    .map(([boxCode, b]) => ({ boxCode, products: b.upcs.size, units: b.units }))
    .sort((a, b) => a.boxCode.localeCompare(b.boxCode));
}

// Sorted good units per UPC on a load (as stored: the manifest line's UPC,
// or the scanned code for extras). For "sorted vs expected" on the manifest
// page and the pack card's real count. Callers match UPCs with upcMatchKeys.
export async function sortedByUpc(manifestId: string): Promise<Map<string, { sorted: number; extra: boolean }>> {
  const rows = await prisma.sortBoxEntry.groupBy({
    by: ["upc", "extra"],
    where: { manifestId },
    _sum: { quantity: true },
  });
  const map = new Map<string, { sorted: number; extra: boolean }>();
  for (const r of rows) {
    const prev = map.get(r.upc);
    map.set(r.upc, { sorted: (prev?.sorted ?? 0) + (r._sum.quantity ?? 0), extra: (prev?.extra ?? false) || r.extra });
  }
  return map;
}
