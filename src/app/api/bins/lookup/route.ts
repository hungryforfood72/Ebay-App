import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getItemLocations, WarehouseError } from "@/lib/warehouse/bins";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import { getShelfState, oldItemIdsOnShelf } from "@/lib/warehouse/shelves";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, getBinDetail, ITEM_ROW_SELECT, onHandUnits, summarizeBins, toItemRow } from "../shared";

// Items still physically somewhere: anything not sold out, sold-out
// listings with bags still in bins (sold online, not picked yet), plus
// pulled listings nobody has taken off the shelf yet.
const ON_HAND: Prisma.ItemWhereInput = {
  OR: [
    { status: { in: ["pending_review", "ready", "exported", "listed"] } },
    { status: "sold", binContents: { some: {} } },
    { status: "expired", shelfPullAcknowledgedAt: null },
  ],
};

type ItemSelected = Prisma.ItemGetPayload<{ select: typeof ITEM_ROW_SELECT }>;

// notInBins = units physically on hand (see onHandUnits) that no bin
// accounts for.
async function withLocations(items: ItemSelected[]) {
  const [locations, onHand] = await Promise.all([
    getItemLocations(items),
    onHandUnits(
      prisma,
      items.map((i) => i.id)
    ),
  ]);
  return items.map((i) => {
    const location = locations.get(i.id)!;
    const inBins = location.bins.reduce((sum, b) => sum + b.units, 0);
    return { item: toItemRow(i), location, notInBins: Math.max(0, (onHand.get(i.id) ?? 0) - inBins) };
  });
}

// "What is this and where is it?" for anything scanned on the Bins page:
//   item label  -> { kind: "item", item, location, notInBins }
//   bin         -> { kind: "bin", bin, contents, moves }
//   UPC         -> { kind: "items", items: [{ item, location, notInBins }] }
//                  (older items have no label, so a UPC is how you find them)
//   shelf label -> { kind: "shelf", shelf, state, bins, legacyItems, legacyCount }
//                  (state: does it take bins yet, see shelves.ts;
//                  legacyItems: old-system items still on it)
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  if (!raw) return NextResponse.json({ error: "Scan something first." }, { status: 400 });
  const code = normalizeCode(raw);
  try {
    const kind = classifyScan(code);
    if (kind === "bin") return NextResponse.json({ kind: "bin", ...(await getBinDetail(code)) });

    if (kind === "item") {
      const item = await prisma.item.findUnique({ where: { sku: code }, select: ITEM_ROW_SELECT });
      if (!item) throw new WarehouseError(`No item with label ${code}.`, 404);
      return NextResponse.json({ kind: "item", ...(await withLocations([item]))[0] });
    }

    if (kind === "upc") {
      const items = await prisma.item.findMany({
        where: { AND: [ON_HAND, { upc: code }] },
        select: ITEM_ROW_SELECT,
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      if (items.length === 0) throw new WarehouseError(`Nothing in stock with UPC ${code}.`, 404);
      return NextResponse.json({ kind: "items", items: await withLocations(items) });
    }

    const state = await getShelfState(prisma, raw);
    if (state) {
      // Old-system items still on it, by the same rule that decides whether
      // the shelf takes bins (shelves.ts), so the list matches the count.
      const [bins, oldIds] = await Promise.all([summarizeBins({ shelfLabel: state.label }), oldItemIdsOnShelf(prisma, state.label)]);
      const found = await prisma.item.findMany({ where: { id: { in: oldIds } }, select: ITEM_ROW_SELECT });
      const byId = new Map(found.map((i) => [i.id, i]));
      const legacyItems = oldIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      return NextResponse.json({
        kind: "shelf",
        shelf: state.label,
        state,
        bins,
        legacyItems: await withLocations(legacyItems),
        legacyCount: state.oldItems,
      });
    }

    // An older item's full sku, if someone typed or pasted it.
    const bySku = await prisma.item.findUnique({ where: { sku: raw }, select: ITEM_ROW_SELECT });
    if (bySku) return NextResponse.json({ kind: "item", ...(await withLocations([bySku]))[0] });

    throw new WarehouseError(`Nothing matches "${raw}". Scan an item label, a bin, a shelf or a UPC.`, 404);
  } catch (e) {
    return binsErrorResponse(e);
  }
}
