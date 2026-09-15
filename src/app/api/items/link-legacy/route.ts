import { findListingsBySku } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const maxDuration = 90;

// Items marked "exported" only ever mean a File Exchange CSV was generated
// (src/lib/csv.ts) — never that eBay confirmed the listing, and never
// through this app's own Inventory API publish flow (which is the only
// thing that normally sets ebayListingId). This looks up each unlinked
// exported item's real listingId by its own sku (verbatim — that's exactly
// what went into the CSV's CustomLabel column) via the Trading API, and
// backfills it so discount/promote can act on listings that were already
// live before this app's real API integration existed.
export async function POST() {
  const items = await prisma.item.findMany({
    where: { status: "exported", ebayListingId: null },
    select: { id: true, sku: true },
  });
  if (items.length === 0) {
    return NextResponse.json({ checked: 0, linked: 0, notFound: 0 });
  }

  const found = await findListingsBySku(items.map((i) => i.sku));

  let linked = 0;
  for (const item of items) {
    const listingId = found.get(item.sku);
    if (!listingId) continue;
    await prisma.item.update({
      where: { id: item.id },
      // ebaySku here is the raw, untransformed sku — that's what's
      // actually on the live legacy listing (File Exchange's CustomLabel
      // got the full app sku, unlike the Inventory API flow which runs it
      // through toEbaySku() first), so order-sync matching stays correct.
      data: { ebayListingId: listingId, ebaySku: item.sku },
    });
    linked++;
  }

  return NextResponse.json({ checked: items.length, linked, notFound: items.length - linked });
}
