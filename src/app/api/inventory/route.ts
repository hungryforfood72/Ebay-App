import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Active listings this app has actually published (or linked up) to eBay —
// "listed" status, has some kind of live-listing reference. A fully sold
// item flips to "sold" elsewhere and drops out of this view on its own,
// same convention the dashboard already uses.
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();

  const items = await prisma.item.findMany({
    where: {
      status: "listed",
      OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }],
      ...(q
        ? {
            OR: [
              { finalTitle: { contains: q, mode: "insensitive" } },
              { upc: { contains: q } },
              { ebayListingId: { contains: q } },
              { sku: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      finalTitle: true,
      sku: true,
      upc: true,
      shelfLocation: true,
      price: true,
      quantity: true,
      soldQuantity: true,
      isMultipack: true,
      packSize: true,
      ebayListingId: true,
      ebayOfferId: true,
      ebayEnvironment: true,
      photoUrls: true,
    },
    orderBy: { finalTitle: "asc" },
    take: 200,
  });

  return NextResponse.json({
    items: items.map((i) => ({
      id: i.id,
      title: i.finalTitle,
      sku: i.sku,
      upc: i.upc,
      shelfLocation: i.shelfLocation,
      price: i.price != null ? Number(i.price) : null,
      quantity: i.quantity,
      soldQuantity: i.soldQuantity,
      // What's actually available to buy right now, per our own records —
      // the same field the Inventory API push now uses (see availableQuantity
      // in ebay.ts). Shown as a starting point; the detail/edit view
      // cross-checks it against eBay's own live number before you commit
      // a change.
      availableQuantity: Math.max(0, i.quantity - i.soldQuantity),
      isMultipack: i.isMultipack,
      packSize: i.packSize,
      ebayListingId: i.ebayListingId,
      ebayOfferId: i.ebayOfferId,
      ebayEnvironment: i.ebayEnvironment,
      photoUrl: i.photoUrls[0] ?? null,
    })),
  });
}
