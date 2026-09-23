import { computeWalkupPrices, getWalkupSaleSettings } from "@/lib/walkupSale";
import { getOfferDetails } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Finds an already-listed shelf item by shelf location + UPC, with no
// manifest needing to be picked first — the point of this route (see
// /api/manifests/[id]/walkup-sale/lookup, which requires already knowing
// which manifest a UPC belongs to). Used by the "Sell Shelf Item" scan mode:
// scan the shelf location, then the UPC, and this figures out which
// listing that is (and which manifest, if any) on its own.
export async function GET(request: NextRequest) {
  const shelfLocation = request.nextUrl.searchParams.get("shelfLocation")?.trim();
  const upc = request.nextUrl.searchParams.get("upc")?.trim();
  if (!shelfLocation) {
    return NextResponse.json({ error: "A shelf location is required." }, { status: 400 });
  }
  if (!upc) {
    return NextResponse.json({ error: "A UPC is required." }, { status: 400 });
  }

  // Bundles are excluded — Item.upc is always null for a bundle, its
  // components carry their own UPCs, and matching into those here isn't
  // worth the complexity for how rarely a bundle would be the thing a
  // walk-up customer points at.
  const matches = await prisma.item.findMany({
    where: {
      shelfLocation: { equals: shelfLocation, mode: "insensitive" },
      upc,
      isBundle: false,
      status: { in: ["listed", "exported"] },
      OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }],
    },
    select: {
      id: true,
      manifestId: true,
      finalTitle: true,
      aiTitle: true,
      price: true,
      quantity: true,
      soldQuantity: true,
      ebayOfferId: true,
      isMultipack: true,
      packSize: true,
    },
  });

  if (matches.length === 0) {
    return NextResponse.json({ error: "No listed item at that shelf location with that UPC." }, { status: 404 });
  }
  if (matches.length > 1) {
    // Never silently guess which one on a money-affecting match — ask
    // Cristian to sort it out by hand instead.
    return NextResponse.json(
      { error: `${matches.length} listed items match that shelf location and UPC — check by hand.` },
      { status: 409 }
    );
  }
  const item = matches[0];

  const storedAvailable = Math.max(0, item.quantity - item.soldQuantity);
  const live = item.ebayOfferId ? await getOfferDetails(item.ebayOfferId) : null;
  const alreadyListed = {
    itemId: item.id,
    // See the equivalent comment in walkup-sale/lookup — eBay's "available
    // quantity" for a multipack listing is in LISTING units (packs), not
    // physical units.
    availableQuantity: live?.availableQuantity ?? storedAvailable,
    isMultipack: item.isMultipack,
    packSize: item.packSize,
  };

  if (!item.manifestId) {
    // Scanned outside manifest mode — no manifest line to price against, so
    // fall back to the item's own current listed price as a reference and
    // let the caller enter a price manually. No manifest sold/profit
    // tracking happens for this sale either, since there's no manifest.
    return NextResponse.json({
      itemId: item.id,
      manifestId: null,
      description: item.finalTitle ?? item.aiTitle ?? "Untitled item",
      currentListedPrice: item.price != null ? Number(item.price) : null,
      alreadyListed,
    });
  }

  const line = await prisma.manifestLine.findFirst({
    where: { manifestId: item.manifestId, upc },
    select: { description: true, retailPrice: true, extendedRetail: true, expectedQuantity: true },
  });
  if (!line) {
    // Shouldn't happen in practice (the Item came from this manifest), but
    // the item is still real and sellable — fall back the same way a
    // manifest-less item does rather than dead-ending the sale.
    return NextResponse.json({
      itemId: item.id,
      manifestId: item.manifestId,
      description: item.finalTitle ?? item.aiTitle ?? "Untitled item",
      currentListedPrice: item.price != null ? Number(item.price) : null,
      alreadyListed,
    });
  }

  const manifest = await prisma.manifest.findUnique({
    where: { id: item.manifestId },
    select: { totalLandedCost: true, lines: { select: { extendedRetail: true } } },
  });
  const totalLandedCost = manifest?.totalLandedCost != null ? Number(manifest.totalLandedCost) : null;
  const totalExtendedRetail = manifest?.lines.reduce((sum, l) => sum + Number(l.extendedRetail), 0) ?? 0;
  const valueShare = totalExtendedRetail > 0 ? Number(line.extendedRetail) / totalExtendedRetail : 0;
  const landedCostPerUnit =
    totalLandedCost != null && line.expectedQuantity > 0
      ? (valueShare * totalLandedCost) / line.expectedQuantity
      : null;

  const settings = await getWalkupSaleSettings();
  const prices = computeWalkupPrices({ retailPrice: Number(line.retailPrice), landedCostPerUnit }, settings);

  return NextResponse.json({
    itemId: item.id,
    manifestId: item.manifestId,
    description: line.description,
    retailPrice: Number(line.retailPrice),
    landedCostPerUnit,
    alreadyListed,
    ...prices,
  });
}
