import { Prisma } from "@/generated/prisma/client";
import { AuthError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { BIN_CODE_PREFIX, codeNumber } from "@/lib/warehouse/codes";
import { findBin, WarehouseError } from "@/lib/warehouse/bins";
import { itemDisplayTitle } from "@/lib/warehouse/itemTitle";
import { NextResponse } from "next/server";

// Helpers shared by the /api/bins routes (not a route itself: only route.ts
// files become endpoints).

// Turns the errors the bins code throws on purpose into a plain JSON
// answer the handheld can show. Anything else is a real bug and is
// rethrown so it shows up in the logs as a 500.
export function binsErrorResponse(e: unknown): NextResponse {
  if (e instanceof WarehouseError || e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  // Two people moving the same units at the same moment can, rarely, make
  // Postgres cancel one of them to break a lock cycle (a pick and a
  // combine touching the same bins). Nothing was saved for that person, so
  // asking them to scan again is the honest answer.
  if (isLockConflict(e)) {
    return NextResponse.json(
      { error: "Someone else is moving this bin right now. Nothing changed, so scan it again." },
      { status: 409 }
    );
  }
  throw e;
}

function isLockConflict(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  // P2028: the transaction ran out of time, usually waiting on a lock
  // someone else held.
  return (
    code === "P2034" ||
    code === "P2028" ||
    code === "40P01" ||
    code === "40001" ||
    /deadlock|transaction (?:already closed|api error)/i.test(e.message)
  );
}

// itemDisplayTitle lives in src/lib/warehouse/itemTitle.ts (the pick list
// uses it too); re-exported so bin routes keep importing it from here.
export { itemDisplayTitle };

// Fields needed for itemDisplayTitle + a bin screen row. Kept to things an
// employee may see: no price or cost.
export const ITEM_ROW_SELECT = {
  id: true,
  sku: true,
  upc: true,
  status: true,
  finalTitle: true,
  aiTitle: true,
  upcLookupData: true,
  photoUrls: true,
  expirationDate: true,
  quantity: true,
  soldQuantity: true,
  isMultipack: true,
  packSize: true,
  shelfLocation: true,
} as const;

type ItemRowSource = {
  id: string;
  sku: string;
  upc: string | null;
  status: string;
  finalTitle: string | null;
  aiTitle: string | null;
  upcLookupData: unknown;
  photoUrls: string[];
  expirationDate: Date | null;
  quantity: number;
  soldQuantity: number;
  isMultipack: boolean;
  packSize: number | null;
  shelfLocation: string;
};

export type ItemRow = {
  id: string;
  // The item's label code (= sku). Older items have a long
  // "(Location - A3)-uuid" sku and no label to scan.
  code: string;
  upc: string | null;
  status: string;
  title: string;
  photoUrl: string | null;
  expirationDate: string | null;
  available: number;
  packSize: number | null;
};

export function toItemRow(item: ItemRowSource): ItemRow {
  return {
    id: item.id,
    code: item.sku,
    upc: item.upc,
    status: item.status,
    title: itemDisplayTitle(item),
    photoUrl: item.photoUrls[0] ?? null,
    expirationDate: item.expirationDate ? item.expirationDate.toISOString() : null,
    available: Math.max(0, item.quantity - item.soldQuantity),
    packSize: item.isMultipack ? item.packSize : null,
  };
}

// "empty" = nothing in it (reuse it). "filling" = open at the binning
// station: has items, nobody tapped Close bin, not on a shelf. "ready" =
// closed, waiting to be shelved. "shelved" = has items and is on a shelf.
export type BinStatus = "empty" | "filling" | "ready" | "shelved";

export function binStatus(items: number, shelfLabel: string | null, closedAt: Date | null): BinStatus {
  if (items === 0) return "empty";
  if (shelfLabel) return "shelved";
  return closedAt ? "ready" : "filling";
}

export type BinSummary = {
  code: string;
  status: BinStatus;
  // Set even on an empty bin: the "empty but still marked on a shelf, go
  // grab it" case.
  shelfLabel: string | null;
  shelvedAt: string | null;
  emptiedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  createdAt: string;
  items: number;
  units: number;
};

// Bins (all, or the ones matching `where`) with their item and unit
// counts, in bin-number order.
export async function summarizeBins(where?: Prisma.BinWhereInput): Promise<BinSummary[]> {
  const bins = await prisma.bin.findMany({ where });
  if (bins.length === 0) return [];
  const counts = await prisma.binContent.groupBy({
    by: ["binId"],
    where: { binId: { in: bins.map((b) => b.id) } },
    _sum: { units: true },
    _count: { _all: true },
  });
  const byBin = new Map(counts.map((c) => [c.binId, { items: c._count._all, units: c._sum.units ?? 0 }]));
  return bins
    .map((b) => {
      const c = byBin.get(b.id) ?? { items: 0, units: 0 };
      return {
        code: b.code,
        status: binStatus(c.items, b.shelfLabel, b.closedAt),
        shelfLabel: b.shelfLabel,
        shelvedAt: b.shelvedAt?.toISOString() ?? null,
        emptiedAt: b.emptiedAt?.toISOString() ?? null,
        closedAt: b.closedAt?.toISOString() ?? null,
        closedBy: b.closedBy,
        createdAt: b.createdAt.toISOString(),
        items: c.items,
        units: c.units,
      };
    })
    .sort((a, b) => (codeNumber(a.code, BIN_CODE_PREFIX) ?? 0) - (codeNumber(b.code, BIN_CODE_PREFIX) ?? 0));
}

export type BinContentRow = ItemRow & { units: number; placedAt: string };

export type BinMoveRow = {
  id: string;
  kind: string;
  itemCode: string | null;
  itemTitle: string | null;
  fromBinCode: string | null;
  toBinCode: string | null;
  shelfLabel: string | null;
  units: number | null;
  note: string | null;
  by: string | null;
  createdAt: string;
};

export type BinDetail = { bin: BinSummary; contents: BinContentRow[]; moves: BinMoveRow[] };

// One bin: what's in it (oldest placement first) and its recent history.
// Throws WarehouseError 404 for an unknown code.
export async function getBinDetail(rawCode: string): Promise<BinDetail> {
  const found = await findBin(prisma, rawCode);
  const [[summary], contents, moves] = await Promise.all([
    summarizeBins({ id: found.id }),
    prisma.binContent.findMany({
      where: { binId: found.id },
      include: { item: { select: ITEM_ROW_SELECT } },
      orderBy: { placedAt: "asc" },
    }),
    prisma.binMove.findMany({
      where: { OR: [{ fromBinCode: found.code }, { toBinCode: found.code }] },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);
  const moveItemIds = [...new Set(moves.map((m) => m.itemId).filter((id): id is string => Boolean(id)))];
  const moveItems = moveItemIds.length
    ? await prisma.item.findMany({ where: { id: { in: moveItemIds } }, select: ITEM_ROW_SELECT })
    : [];
  const moveItemById = new Map(moveItems.map((i) => [i.id, i]));
  return {
    bin: summary,
    contents: contents.map((c) => ({ ...toItemRow(c.item), units: c.units, placedAt: c.placedAt.toISOString() })),
    moves: moves.map((m) => {
      const item = m.itemId ? moveItemById.get(m.itemId) : undefined;
      return {
        id: m.id,
        kind: m.kind,
        itemCode: item?.sku ?? null,
        itemTitle: item ? itemDisplayTitle(item) : null,
        fromBinCode: m.fromBinCode,
        toBinCode: m.toBinCode,
        shelfLabel: m.shelfLabel,
        units: m.units,
        note: m.note,
        by: m.by,
        createdAt: m.createdAt.toISOString(),
      };
    }),
  };
}

// Units of a listing physically still in the building, whether or not
// they're in a bin yet:
//   quantity                      every unit ever listed (stock removals on
//                                 the Inventory page lower quantity itself)
//   - units sold in person        (InPersonSale: they walked out the door)
//   - units picked for orders     (OrderPick rows, eBay and Shopify alike)
// Not quantity - soldQuantity: an online sale bumps soldQuantity the moment
// it sells, but the bag stays on the shelf until it's picked, and binning
// happens after listing, so a fast seller's real bags would otherwise be
// refused as "extra labels".
export const ON_HAND_SQL = Prisma.sql`(
  i.quantity
  - COALESCE((SELECT SUM(s.quantity) FROM "InPersonSale" s WHERE s."itemId" = i.id), 0)
  - (SELECT COUNT(*) FROM "OrderPick" p WHERE p."itemId" = i.id)
)`;

type Db = Prisma.TransactionClient | typeof prisma;

// On-hand units for each item id, never below 0. ON_HAND_SQL for
// warehouse-mode items (ES label). Items listed before warehouse mode had
// their online sales shipped without a pick scan, so for them it's
// quantity - soldQuantity, as everywhere else in the app.
export async function onHandUnits(db: Db, itemIds: string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ id: string; onHand: number }[]>`
    SELECT i.id,
      (CASE WHEN i.sku ~ '^ES[0-9]+$' THEN ${ON_HAND_SQL} ELSE i.quantity - i."soldQuantity" END)::int AS "onHand"
    FROM "Item" i WHERE i.id IN (${Prisma.join(itemIds)})`;
  return new Map(rows.map((r) => [r.id, Math.max(0, r.onHand)]));
}

// How many more units of an item can go into bins: on hand minus what bins
// already hold. Locks the item row first so two scans of the same listing
// at once (two bagged labels on two handhelds, or a put-away at the same
// moment) can't both pass. Must run inside a transaction.
export async function lockItemRoom(tx: Prisma.TransactionClient, itemId: string) {
  await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${itemId} FOR UPDATE`;
  const item = await tx.item.findUniqueOrThrow({ where: { id: itemId }, select: { sku: true, status: true } });
  const bins = await tx.binContent.findMany({
    where: { itemId },
    select: { units: true, bin: { select: { code: true } } },
    orderBy: { placedAt: "asc" },
  });
  const onHand = (await onHandUnits(tx, [itemId])).get(itemId) ?? 0;
  const inBins = bins.reduce((sum, b) => sum + b.units, 0);
  return { item, onHand, inBins, room: onHand - inBins, bins: bins.map((b) => b.bin.code) };
}

export function readCode(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
