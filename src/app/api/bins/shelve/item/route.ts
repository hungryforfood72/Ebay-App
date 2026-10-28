import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findBin, lockItemBins, moveUnits, placeInBin, WarehouseError } from "@/lib/warehouse/bins";
import { classifyScan, normalizeCode, shelfBinCode } from "@/lib/warehouse/codes";
import { getShelfState } from "@/lib/warehouse/shelves";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, ITEM_ROW_SELECT, lockItemRoom, readCode, summarizeBins, toItemRow } from "../../shared";

// Shelve tab on an oversized shelf (Cristian, 2026-10-28): one scanned item
// label = one unit onto the shelf. { shelfLabel, itemCode } ->
// { item, bin, fromBinCode, fromEmpty }.
//   - a unit not in any bin yet goes straight on (like Fill bins)
//   - otherwise one unit comes out of the bin it's in, a bin that's off
//     its shelf first (that's the one in someone's hands), and the bin
//     comes off its shelf if that emptied it
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const shelfLabel = readCode(body.shelfLabel);
  const itemCode = normalizeCode(readCode(body.itemCode));
  if (!shelfLabel) return NextResponse.json({ error: "Scan the oversized shelf first." }, { status: 400 });
  if (classifyScan(itemCode) !== "item") {
    return NextResponse.json(
      { error: "Scan the item label (starts with ES). An older item with no label goes on with Put away." },
      { status: 400 }
    );
  }
  const by = getRequestUser(request)?.username ?? null;
  try {
    const shelf = await getShelfState(prisma, shelfLabel);
    if (!shelf) throw new WarehouseError(`No shelf called "${shelfLabel}".`, 404);
    if (!shelf.oversized) throw new WarehouseError(`Shelf ${shelf.label} takes bins, not loose items. Scan a bin.`, 409);
    const found = await prisma.item.findUnique({ where: { sku: itemCode }, select: { id: true } });
    if (!found) throw new WarehouseError(`No item with label ${itemCode}.`, 404);
    const shelfCode = shelfBinCode(shelf.label);

    const result = await prisma.$transaction(async (tx) => {
      // Bin locks (the shelf's and every bin holding the item) before the
      // item lock: the lock order in bins.ts.
      await lockItemBins(tx, found.id, [shelfCode]);
      const shelfBin = await findBin(tx, shelfCode);
      const { item, onHand, room } = await lockItemRoom(tx, found.id);
      if (item.status === "expired") throw new WarehouseError(`${itemCode} was pulled for expiry. Set it aside.`, 409);
      if (room > 0) {
        await placeInBin(tx, { itemId: found.id, binCode: shelfCode, units: 1, by, note: "Put on oversized shelf" });
        return { fromBinCode: null, fromEmpty: false };
      }
      const rows = await tx.binContent.findMany({
        where: { itemId: found.id, binId: { not: shelfBin.id } },
        select: { bin: { select: { code: true, shelfLabel: true } } },
        orderBy: { placedAt: "asc" },
      });
      if (rows.length === 0) {
        throw new WarehouseError(
          onHand === 0
            ? `${itemCode} has none left here (all sold or picked). Extra label?`
            : `All ${onHand} of ${itemCode} ${onHand === 1 ? "is" : "are"} already on shelf ${shelf.label}.`,
          409
        );
      }
      const from = rows.find((r) => !r.bin.shelfLabel) ?? rows[0];
      const { fromEmpty } = await moveUnits(tx, {
        itemId: found.id,
        fromBinCode: from.bin.code,
        toBinCode: shelfCode,
        units: 1,
        by,
        note: "Put on oversized shelf",
      });
      return { fromBinCode: from.bin.code, fromEmpty };
    });

    const [item, [bin]] = await Promise.all([
      prisma.item.findUniqueOrThrow({ where: { id: found.id }, select: ITEM_ROW_SELECT }),
      summarizeBins({ code: shelfCode }),
    ]);
    return NextResponse.json({ item: toItemRow(item), bin, ...result });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
