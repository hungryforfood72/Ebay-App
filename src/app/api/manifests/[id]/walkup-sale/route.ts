import { EbayApiError, getOfferDetails, reviseFixedPriceItemQuantity, updateOfferQuantity } from "@/lib/ebay";
import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Records an in-person, cash, no-fee/no-shipping sale straight out of a
// manifest — same tally pattern as .../damaged and .../duds, plus the real
// negotiated price. recordedBy comes from the signed-in session (not the
// request body) so it can't be spoofed, same fix already applied to
// StockAdjustment this session.
//
// Two distinct paths depending on whether the item was already scanned in
// and is actively listed on eBay (itemId present) or is being sold
// straight off the manifest before ever going through the normal flow
// (itemId absent). Getting these confused double-counts "received" and
// leaves eBay's live stock too high — see the itemId branch below.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const upc = String(body.upc ?? "").trim();
  const quantity = Number(body.quantity);
  const pricePerUnit = Number(body.pricePerUnit);
  const itemId = typeof body.itemId === "string" && body.itemId ? body.itemId : null;

  if (!upc) {
    return NextResponse.json({ error: "UPC is required." }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity < 1) {
    return NextResponse.json({ error: "Quantity must be at least 1." }, { status: 400 });
  }
  if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
    return NextResponse.json({ error: "Price per unit must be a positive number." }, { status: 400 });
  }

  const recordedBy = getRequestUser(request)?.username ?? null;
  const roundedQuantity = Math.round(quantity);

  if (!itemId) {
    // Fresh off the manifest — never scanned in, nothing to reconcile
    // against on eBay. This is what the manifest reconciliation route's
    // receivedByUpc/soldByUpc already fold in for ManifestWalkupSale rows.
    const entry = await prisma.manifestWalkupSale.create({
      data: { manifestId: id, upc, quantity: roundedQuantity, pricePerUnit, note: body.note ?? null, recordedBy },
    });
    return NextResponse.json(entry, { status: 201 });
  }

  // Already inventoried: the manifest's own receivedByUpc/soldByUpc
  // already count this UPC via the Item's quantity/soldQuantity fields
  // (see GET /api/manifests/[id]) — so instead of a ManifestWalkupSale
  // row (which would double-count it), record the sale directly against
  // the Item, exactly like a normal eBay sale would, and push the reduced
  // quantity to the live listing so it can't also sell online.
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item || item.manifestId !== id || item.upc !== upc) {
    return NextResponse.json({ error: "That item doesn't match this manifest/UPC." }, { status: 400 });
  }
  if (!item.ebayOfferId && !item.ebayListingId) {
    return NextResponse.json({ error: "This item isn't currently listed on eBay." }, { status: 400 });
  }

  const storedAvailable = Math.max(0, item.quantity - item.soldQuantity);
  const live = item.ebayOfferId ? await getOfferDetails(item.ebayOfferId) : null;
  const currentAvailable = live?.availableQuantity ?? storedAvailable;

  const newAvailable = currentAvailable - roundedQuantity;
  if (newAvailable < 0) {
    return NextResponse.json(
      { error: `Only ${currentAvailable} currently available on eBay — can't sell ${roundedQuantity}.` },
      { status: 400 }
    );
  }
  const newSoldQuantity = item.soldQuantity + roundedQuantity;
  const note = `Walk-up sale — ${roundedQuantity} unit(s) @ $${pricePerUnit.toFixed(2)} each, in person`;

  try {
    if (item.ebayOfferId) {
      await updateOfferQuantity(item.ebayOfferId, { sku: item.sku, soldQuantity: newSoldQuantity }, newAvailable);
    } else {
      await reviseFixedPriceItemQuantity(item.ebayListingId!, newAvailable + newSoldQuantity);
    }
    const [updatedItem, adjustment] = await prisma.$transaction([
      prisma.item.update({
        where: { id: itemId },
        data: {
          soldQuantity: newSoldQuantity,
          soldRevenueTotal: { increment: roundedQuantity * pricePerUnit },
          status: newSoldQuantity >= item.quantity ? "sold" : undefined,
        },
      }),
      prisma.stockAdjustment.create({
        data: {
          itemId,
          delta: -roundedQuantity,
          previousAvailable: currentAvailable,
          newAvailable,
          note,
          recordedBy,
        },
      }),
    ]);
    return NextResponse.json({ item: updatedItem, adjustment }, { status: 201 });
  } catch (e) {
    // eBay push failed — don't touch the Item (DB and the live listing
    // must never disagree, same reasoning as /api/items/[id]/quantity),
    // but still record the attempted sale so the intent isn't lost.
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Failed to update eBay listing.";
    await prisma.stockAdjustment.create({
      data: {
        itemId,
        delta: -roundedQuantity,
        previousAvailable: currentAvailable,
        newAvailable: currentAvailable,
        note: `${note} [FAILED: ${message}]`,
        recordedBy,
      },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
