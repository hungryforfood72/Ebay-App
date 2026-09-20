import { computeWalkupPrices, getWalkupSaleSettings } from "@/lib/walkupSale";
import { getOfferDetails } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Instant, table-side pricing for a scanned UPC — deliberately cheap and
// independent of the full manifest reconciliation route (GET
// /api/manifests/[id]), which needs the heavier duplicate-UPC allocation
// logic to compute a precise receivedUnits per line. Here, landed cost per
// unit is approximated using the line's own expectedQuantity instead of
// its true receivedUnits — good enough for an instant walk-up price, not
// meant to replace the exact weightedCogsPerUnit shown on the manifest
// page itself.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const upc = request.nextUrl.searchParams.get("upc")?.trim();
  if (!upc) {
    return NextResponse.json({ error: "A UPC is required." }, { status: 400 });
  }

  const manifest = await prisma.manifest.findUnique({
    where: { id },
    select: {
      totalLandedCost: true,
      lines: { select: { upc: true, extendedRetail: true } },
    },
  });
  if (!manifest) {
    return NextResponse.json({ error: "Manifest not found." }, { status: 404 });
  }

  const line = await prisma.manifestLine.findFirst({
    where: { manifestId: id, upc },
    select: { description: true, retailPrice: true, extendedRetail: true, expectedQuantity: true },
  });
  if (!line) {
    return NextResponse.json({ error: "No line on this manifest matches that UPC." }, { status: 404 });
  }

  const totalLandedCost = manifest.totalLandedCost != null ? Number(manifest.totalLandedCost) : null;
  const totalExtendedRetail = manifest.lines.reduce((sum, l) => sum + Number(l.extendedRetail), 0);
  const valueShare = totalExtendedRetail > 0 ? Number(line.extendedRetail) / totalExtendedRetail : 0;
  const landedCostPerUnit =
    totalLandedCost != null && line.expectedQuantity > 0
      ? (valueShare * totalLandedCost) / line.expectedQuantity
      : null;

  const settings = await getWalkupSaleSettings();
  const prices = computeWalkupPrices({ retailPrice: Number(line.retailPrice), landedCostPerUnit }, settings);

  // If this UPC is already a real, currently-listed Item (scanned in and
  // published, not just sitting on the manifest CSV), selling it walk-up
  // needs a different path — see .../walkup-sale POST's itemId branch:
  // reduce the live eBay listing instead of logging a fresh "received"
  // tally, or the manifest would double-count it. Bundles are excluded —
  // Item.upc is always null for a bundle, its components carry their own
  // UPCs, and matching into those here isn't worth the complexity for how
  // rarely it'd come up.
  const listedItem = await prisma.item.findFirst({
    where: {
      manifestId: id,
      upc,
      isBundle: false,
      status: { in: ["listed", "exported"] },
      OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }],
    },
    select: { id: true, sku: true, quantity: true, soldQuantity: true, ebayOfferId: true },
  });

  let alreadyListed: { itemId: string; availableQuantity: number } | null = null;
  if (listedItem) {
    const storedAvailable = Math.max(0, listedItem.quantity - listedItem.soldQuantity);
    const live = listedItem.ebayOfferId ? await getOfferDetails(listedItem.ebayOfferId) : null;
    alreadyListed = { itemId: listedItem.id, availableQuantity: live?.availableQuantity ?? storedAvailable };
  }

  return NextResponse.json({
    description: line.description,
    retailPrice: Number(line.retailPrice),
    landedCostPerUnit,
    alreadyListed,
    ...prices,
  });
}
