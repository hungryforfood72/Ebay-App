import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findBin, getItemLocations, lockBins, placeInBin, WarehouseError } from "@/lib/warehouse/bins";
import { normalizeCode } from "@/lib/warehouse/codes";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, ITEM_ROW_SELECT, lockItemRoom, onHandUnits, readCode, summarizeBins, toItemRow } from "../shared";

// Puts units of a listing into a bin: stray units found loose, stock added
// on the Inventory page, or an older item (shelf only, no bin) being moved
// into the bin system.
// { itemId? | itemCode?, binCode, units } -> { item, bin, location, notInBins }.
// itemCode is the label (sku). Older items have no label, so the page
// finds them by UPC first and sends itemId.
//
// Bins can't hold more units than are physically on hand (see
// onHandUnits): a bin that claims stock that's gone would send a picker
// hunting for nothing.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const itemId = readCode(body.itemId);
  const itemCode = readCode(body.itemCode);
  const binCode = readCode(body.binCode);
  const units = Number(body.units);
  if (!itemId && !itemCode) return NextResponse.json({ error: "Scan the item label first." }, { status: 400 });
  if (!binCode) return NextResponse.json({ error: "Scan a bin." }, { status: 400 });
  if (!Number.isInteger(units) || units < 1) {
    return NextResponse.json({ error: "Units must be a whole number, at least 1." }, { status: 400 });
  }
  const by = getRequestUser(request)?.username ?? null;

  try {
    const found = await prisma.item.findFirst({
      where: itemId ? { id: itemId } : { sku: { equals: normalizeCode(itemCode), mode: "insensitive" } },
      select: { id: true },
    });
    if (!found) {
      throw new WarehouseError(itemId ? "That item doesn't exist anymore." : `No item with code ${normalizeCode(itemCode)}.`, 404);
    }

    const binId = await prisma.$transaction(async (tx) => {
      // Bin lock before the item lock, same order as Fill bins (bins.ts).
      await lockBins(tx, [binCode]);
      // Locks the item so two people putting the same listing away at once
      // can't both pass the "fits in what's on hand" check below. A sold-out
      // listing can still have bags waiting to be picked, so only a pulled
      // one is refused outright.
      const { item, onHand, inBins, room } = await lockItemRoom(tx, found.id);
      if (item.status === "expired") throw new WarehouseError("This listing was pulled, so it can't go in a bin.");
      if (units > room) {
        throw new WarehouseError(
          room <= 0
            ? onHand === 0
              ? "None of this listing are left here (all sold or picked)."
              : `All ${onHand} on hand are already in bins. Adding stock? Add it on the Inventory page first.`
            : `Only ${room} of this listing ${room === 1 ? "isn't" : "aren't"} in a bin yet (${onHand} on hand, ${inBins} already in bins).`
        );
      }
      const bin = await findBin(tx, binCode);
      await placeInBin(tx, { itemId: found.id, binCode: bin.code, units, by, note: "Put away" });
      return bin.id;
    });

    const item = await prisma.item.findUniqueOrThrow({ where: { id: found.id }, select: ITEM_ROW_SELECT });
    const location = (await getItemLocations([item])).get(item.id)!;
    const [bin] = await summarizeBins({ id: binId });
    const inBins = location.bins.reduce((sum, b) => sum + b.units, 0);
    const onHand = (await onHandUnits(prisma, [item.id])).get(item.id) ?? 0;
    return NextResponse.json({ item: toItemRow(item), bin, location, notInBins: Math.max(0, onHand - inBins) });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
