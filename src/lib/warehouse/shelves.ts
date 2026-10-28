import { Prisma } from "@/generated/prisma/client";
import { naturalSort } from "../naturalSort";
import { prisma } from "../prisma";
import { WarehouseError } from "./bins";
import { normalizeCode, shelfBinCode } from "./codes";

// Go-live cutover for warehouse mode (Cristian, 2026-10-17): everything
// listed before stays exactly where it is (Item.shelfLocation like "A5",
// no ES label, no bins). Nothing is reprocessed. A shelf only starts taking
// bins once it's fully empty of those old-system items.
//
// Per shelf:
//   "free"        no old item ever had this shelf (any status): bins allowed
//   "old_items"   old items still physically there: bins refused
//   "looks_empty" none left by the records, but nobody has confirmed it
//   "bins"        someone looked and confirmed it empty (binsAllowedAt)
//
// "Still physically there" = old item (sku not an ES code) on this shelf
// with units left (quantity - soldQuantity > 0) and not sold out or
// expired, plus expired ones nobody has pulled yet (shelfPullAcknowledgedAt
// null). The records can't be the final word: an old unit that sold online
// but hasn't shipped yet already counts in soldQuantity while it still sits
// on the shelf. That's why a person confirms "it's really empty" instead of
// the shelf flipping to bins on its own.

export type ShelfBinState = "free" | "old_items" | "looks_empty" | "bins";

export type ShelfState = {
  label: string;
  state: ShelfBinState;
  // Old-system items still on it, and their units left.
  oldItems: number;
  oldUnits: number;
  binsAllowedAt: string | null;
  binsAllowedBy: string | null;
  // Bins marked on this shelf right now (any, including empty ones). Not
  // counting an oversized shelf's own hidden bin.
  bins: number;
  // Oversized shelf: no bins, items straight on it (units = on it now).
  oversized: boolean;
  oversizedUnits: number;
};

type Db = Prisma.TransactionClient | typeof prisma;

const IS_OLD = Prisma.sql`i.sku !~ '^ES[0-9]+$'`;

// The "still physically there" rule above, as SQL on Item i.
export const OLD_ITEM_STILL_THERE_SQL = Prisma.sql`(
  (i.status NOT IN ('sold', 'expired') AND i.quantity - i."soldQuantity" > 0)
  OR (i.status = 'expired' AND i."shelfPullAcknowledgedAt" IS NULL)
)`;

// Matches Item.shelfLocation to a shelf label the way staff typed them:
// ignoring case and stray spaces.
export const shelfKey = (label: string) => label.trim().toLowerCase();

type Counts = { ever: number; left: number; units: number };

async function oldItemCounts(db: Db, labels?: string[]): Promise<Map<string, Counts>> {
  const filter = labels
    ? Prisma.sql`AND lower(trim(i."shelfLocation")) IN (${Prisma.join(labels.map(shelfKey))})`
    : Prisma.empty;
  const rows = await db.$queryRaw<{ key: string; ever: number; left: number; units: number }[]>`
    SELECT lower(trim(i."shelfLocation")) AS key,
      COUNT(*)::int AS ever,
      (COUNT(*) FILTER (WHERE ${OLD_ITEM_STILL_THERE_SQL}))::int AS left,
      COALESCE(SUM(GREATEST(i.quantity - i."soldQuantity", 0)) FILTER (WHERE ${OLD_ITEM_STILL_THERE_SQL}), 0)::int AS units
    FROM "Item" i
    WHERE ${IS_OLD} AND trim(i."shelfLocation") <> '' ${filter}
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.key, { ever: r.ever, left: r.left, units: r.units }]));
}

// Ids of the old-system items still on a shelf (the rule at the top),
// oldest first, for the shelf look-up's "what's still here" list.
export async function oldItemIdsOnShelf(db: Db, label: string, limit = 100): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT i.id FROM "Item" i
    WHERE ${IS_OLD} AND lower(trim(i."shelfLocation")) = ${shelfKey(label)} AND ${OLD_ITEM_STILL_THERE_SQL}
    ORDER BY i."createdAt" ASC
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

function toState(
  shelf: { label: string; binsAllowedAt: Date | null; binsAllowedBy: string | null; oversized: boolean },
  counts: Counts | undefined,
  bins: number,
  oversizedUnits: number
): ShelfState {
  const c = counts ?? { ever: 0, left: 0, units: 0 };
  const state: ShelfBinState = shelf.binsAllowedAt
    ? "bins"
    : c.ever === 0
      ? "free"
      : c.left > 0
        ? "old_items"
        : "looks_empty";
  return {
    label: shelf.label,
    state,
    oldItems: c.left,
    oldUnits: c.units,
    binsAllowedAt: shelf.binsAllowedAt?.toISOString() ?? null,
    binsAllowedBy: shelf.binsAllowedBy,
    bins,
    oversized: shelf.oversized,
    oversizedUnits,
  };
}

// Units sitting on each oversized shelf (in its shelf bin), by shelf label.
async function oversizedUnitsByShelf(db: Db, labels?: string[]): Promise<Map<string, number>> {
  const rows = await db.binContent.groupBy({
    by: ["binId"],
    where: { bin: { shelfBin: true, ...(labels ? { shelfLabel: { in: labels } } : {}) } },
    _sum: { units: true },
  });
  if (rows.length === 0) return new Map();
  const bins = await db.bin.findMany({ where: { id: { in: rows.map((r) => r.binId) } }, select: { id: true, shelfLabel: true } });
  const label = new Map(bins.map((b) => [b.id, b.shelfLabel]));
  return new Map(rows.map((r) => [label.get(r.binId) ?? "", r._sum.units ?? 0]));
}

// Every shelf's state, in natural order (A1, A2, ... A10).
export async function getShelfStates(db: Db = prisma): Promise<ShelfState[]> {
  const [shelves, counts, binCounts, oversized] = await Promise.all([
    db.shelfLocation.findMany(),
    oldItemCounts(db),
    db.bin.groupBy({ by: ["shelfLabel"], where: { shelfLabel: { not: null }, shelfBin: false }, _count: { _all: true } }),
    oversizedUnitsByShelf(db),
  ]);
  const binsByShelf = new Map(binCounts.map((b) => [b.shelfLabel!, b._count._all]));
  return naturalSort(
    shelves.map((s) =>
      toState(s, counts.get(shelfKey(s.label)), binsByShelf.get(s.label) ?? 0, oversized.get(s.label) ?? 0)
    ),
    (s) => s.label
  );
}

// One shelf's state by label (any case). null if there's no such shelf.
export async function getShelfState(db: Db, label: string): Promise<ShelfState | null> {
  const shelf = await db.shelfLocation.findFirst({ where: { label: { equals: label.trim(), mode: "insensitive" } } });
  if (!shelf) return null;
  const [counts, bins, oversized] = await Promise.all([
    oldItemCounts(db, [shelf.label]),
    db.bin.count({ where: { shelfLabel: shelf.label, shelfBin: false } }),
    oversizedUnitsByShelf(db, [shelf.label]),
  ]);
  return toState(shelf, counts.get(shelfKey(shelf.label)), bins, oversized.get(shelf.label) ?? 0);
}

export function shelfTakesBins(state: ShelfState): boolean {
  return !state.oversized && (state.state === "free" || state.state === "bins");
}

// Why a shelf can't take bins yet, in words for the handheld. null = it can.
export function shelfRefusal(state: ShelfState): string | null {
  if (state.oversized) {
    return `Shelf ${state.label} is for oversized items, no bins. To put items on it, scan the shelf's label at Shelve or Fill bins, then the item labels. To move a whole bin onto it, use Combine.`;
  }
  if (state.state === "old_items") {
    return `Shelf ${state.label} still has ${state.oldItems} old-system ${state.oldItems === 1 ? "item" : "items"} (${state.oldUnits} ${state.oldUnits === 1 ? "unit" : "units"}). Bins can go here once it's empty.`;
  }
  if (state.state === "looks_empty") {
    return `Shelf ${state.label} looks empty now. Check it's really empty, then tap Confirm empty on the Bins page.`;
  }
  return null;
}

// For shelveBin: throws the refusal (409) unless the shelf takes bins.
export async function assertShelfTakesBins(db: Db, label: string): Promise<ShelfState> {
  const state = await getShelfState(db, label);
  if (!state) throw new WarehouseError(`No shelf called "${label.trim()}". Add it in Settings first.`, 404);
  const refusal = shelfRefusal(state);
  if (refusal) throw new WarehouseError(refusal, 409);
  return state;
}

// "I looked, it's really empty": only from looks_empty. Serialized per
// shelf so two taps can't race an undo.
export async function confirmShelfEmpty(label: string, by: string | null): Promise<ShelfState> {
  return prisma.$transaction(async (tx) => {
    const before = await getShelfState(tx, label);
    if (!before) throw new WarehouseError(`No shelf called "${label.trim()}".`, 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`warehouse_shelf:${before.label}`}))`;
    const state = (await getShelfState(tx, before.label))!;
    if (state.state === "bins" || state.state === "free") return state;
    if (state.state === "old_items") throw new WarehouseError(shelfRefusal(state)!, 409);
    await tx.shelfLocation.update({
      where: { label: state.label },
      data: { binsAllowedAt: new Date(), binsAllowedBy: by },
    });
    return (await getShelfState(tx, state.label))!;
  });
}

// Owner's undo of a mistaken confirm. Refused once bins are on the shelf.
export async function undoShelfConfirm(label: string): Promise<ShelfState> {
  return prisma.$transaction(async (tx) => {
    const before = await getShelfState(tx, label);
    if (!before) throw new WarehouseError(`No shelf called "${label.trim()}".`, 404);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`warehouse_shelf:${before.label}`}))`;
    const state = (await getShelfState(tx, before.label))!;
    if (!state.binsAllowedAt) return state;
    if (state.bins > 0) {
      throw new WarehouseError(
        `Shelf ${state.label} already has ${state.bins} ${state.bins === 1 ? "bin" : "bins"} on it. Move them off first.`,
        409
      );
    }
    await tx.shelfLocation.update({ where: { label: state.label }, data: { binsAllowedAt: null, binsAllowedBy: null } });
    return (await getShelfState(tx, state.label))!;
  });
}

// Owner: makes a shelf oversized (items straight on it, no bins) or a
// normal bin shelf again (Cristian, 2026-10-24). On: refused while bins
// are on it; creates its hidden shelf bin (Bin.shelfBin). Off: refused
// while items are still on it; removes the shelf bin. Serialized per shelf
// like confirm/undo.
export async function setShelfOversized(label: string, on: boolean, by: string | null): Promise<ShelfState> {
  return prisma.$transaction(async (tx) => {
    const before = await getShelfState(tx, label);
    if (!before) throw new WarehouseError(`No shelf called "${label.trim()}".`, 404);
    // The shelf bin's lock first (bins.ts lock order: bins, then the rest),
    // so nothing is placed on it while it's being removed; then the shelf's.
    const code = shelfBinCode(before.label);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`warehouse_bin:${code}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`warehouse_shelf:${before.label}`}))`;
    const state = (await getShelfState(tx, before.label))!;
    if (state.oversized === on) return state;
    if (on) {
      if (state.bins > 0) {
        throw new WarehouseError(
          `Shelf ${state.label} has ${state.bins} ${state.bins === 1 ? "bin" : "bins"} on it. Move ${state.bins === 1 ? "it" : "them"} off first.`,
          409
        );
      }
      const existing = await tx.bin.findUnique({ where: { code } });
      if (existing && !existing.shelfBin) throw new WarehouseError(`A bin called ${code} already exists.`, 409);
      const now = new Date();
      await tx.bin.upsert({
        where: { code },
        create: { code, shelfBin: true, shelfLabel: state.label, shelvedAt: now, shelvedBy: by },
        update: { shelfLabel: state.label, shelvedAt: now, shelvedBy: by },
      });
      await tx.shelfLocation.update({ where: { label: state.label }, data: { oversized: true, oversizedAt: now, oversizedBy: by } });
    } else {
      if (state.oversizedUnits > 0) {
        throw new WarehouseError(
          `Shelf ${state.label} still has ${state.oversizedUnits} ${state.oversizedUnits === 1 ? "unit" : "units"} on it. Move them off first.`,
          409
        );
      }
      await tx.bin.deleteMany({ where: { code, shelfBin: true } });
      await tx.shelfLocation.update({ where: { label: state.label }, data: { oversized: false, oversizedAt: null, oversizedBy: null } });
    }
    return (await getShelfState(tx, state.label))!;
  });
}

// What a scan at a "scan a bin" step really means: a bin's code, or an
// oversized shelf's label, which stands for its hidden shelf bin. Returns
// the bin code to use (unknown codes come back as typed, for findBin's
// "no bin" answer). Resolve before taking bin locks, so everyone locks the
// shelf bin by the same code.
export async function resolveBinScan(db: Db, raw: string): Promise<string> {
  const code = normalizeCode(raw);
  if (await db.bin.findUnique({ where: { code }, select: { id: true } })) return code;
  const shelf = await db.shelfLocation.findFirst({ where: { label: { equals: raw.trim(), mode: "insensitive" } } });
  if (!shelf) return code;
  if (!shelf.oversized) {
    throw new WarehouseError(`That's shelf ${shelf.label}, a bin shelf. Scan a bin's label.`, 409);
  }
  return shelfBinCode(shelf.label);
}
