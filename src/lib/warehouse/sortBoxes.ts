import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { upcMatchKeys } from "../upcMatch";
import { WarehouseError } from "./bins";
import { codeNumber, formatSortBoxCode, normalizeCode, SORT_BOX_CODE_PREFIX } from "./codes";

// Sort boxes (SortBox / SortBoxEntry). Cristian's flow (2026-10-18): the
// whole load is sorted into boxes before listing starts. The sorter scans a
// box to make it active and every "Good" goes into it; at the List page,
// scanning a product shows which boxes hold it and pulls every unit of it to
// the listing table. Boxes are reused: one whose units have all been pulled
// is free for the next load. Every change to sort box contents goes through
// this file.

type Tx = Prisma.TransactionClient;

export type SortLocation = { boxCode: string; inBox: number; pulled: number; sorted: number };

// Where units sorted on a no-box load (Manifest.sortWithoutBoxes) show up:
// a "box" called this on the List page.
export const NO_BOX = "Not boxed";

// Makes `count` new boxes numbered after the highest existing one.
export async function createSortBoxes(count: number): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new WarehouseError("Make between 1 and 500 sort boxes at a time.");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('warehouse_create_sort_boxes'))`;
    const existing = await tx.sortBox.findMany({ select: { code: true } });
    const start = Math.max(0, ...existing.map((b) => codeNumber(b.code, SORT_BOX_CODE_PREFIX) ?? 0)) + 1;
    const codes = Array.from({ length: count }, (_, i) => formatSortBoxCode(start + i));
    await tx.sortBox.createMany({ data: codes.map((code) => ({ code })) });
    return codes;
  });
}

export async function findSortBox(tx: Tx | typeof prisma, rawCode: string) {
  const code = normalizeCode(rawCode);
  const box = await tx.sortBox.findUnique({ where: { code } });
  if (!box) throw new WarehouseError(`No sort box with code ${code}. Check the label.`, 404);
  return box;
}

// Units still physically in a box (sorted in, not yet pulled to listing).
async function unitsLeft(tx: Tx, boxId: string): Promise<number> {
  const rows = await tx.sortBoxEntry.findMany({ where: { boxId }, select: { quantity: true, pulledUnits: true } });
  return rows.reduce((sum, r) => sum + r.quantity - r.pulledUnits, 0);
}

// Makes a box the sorter's active box for a load. An empty box (never used,
// or everything in it already pulled) gets tied to this load; a box still
// holding another load's units is refused, so two loads never mix in one box.
export async function activateSortBox(args: { boxCode: string; manifestId: string }) {
  return prisma.$transaction(async (tx) => {
    const box = await findSortBox(tx, args.boxCode);
    await tx.$executeRaw`SELECT id FROM "SortBox" WHERE id = ${box.id} FOR UPDATE`;
    const fresh = await tx.sortBox.findUniqueOrThrow({ where: { id: box.id } });
    if (fresh.manifestId === args.manifestId) return { boxCode: fresh.code, reassigned: false };
    if (fresh.manifestId) {
      const left = await unitsLeft(tx, fresh.id);
      if (left > 0) {
        const other = await tx.manifest.findUnique({ where: { id: fresh.manifestId }, select: { title: true } });
        throw new WarehouseError(
          `${fresh.code} still has ${left} unit${left === 1 ? "" : "s"} from "${other?.title ?? "another load"}". Use an empty box.`,
          409
        );
      }
    }
    await tx.sortBox.update({ where: { id: fresh.id }, data: { manifestId: args.manifestId, assignedAt: new Date() } });
    return { boxCode: fresh.code, reassigned: true };
  });
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

function summarize(entries: { quantity: number; pulledUnits: number; box: { code: string } | null }[]): SortLocation[] {
  const byBox = new Map<string, SortLocation>();
  for (const e of entries) {
    const code = e.box?.code ?? NO_BOX;
    const loc = byBox.get(code) ?? { boxCode: code, inBox: 0, pulled: 0, sorted: 0 };
    loc.sorted += e.quantity;
    loc.pulled += e.pulledUnits;
    loc.inBox += e.quantity - e.pulledUnits;
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
