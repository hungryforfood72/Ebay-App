import { findListingsBySku, getEbayEnvironment } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const maxDuration = 90;

// Items marked "exported" only ever mean a File Exchange CSV was generated
// (src/lib/csv.ts) — never that eBay confirmed the listing, and never
// through this app's own Inventory API publish flow (which is the only
// thing that normally sets ebayListingId). This looks up each unlinked
// exported item's real listingId by its own sku (what went into the CSV's
// CustomLabel column, though eBay stores at most the first 50 chars of it
// — see below) via the Trading API, and backfills it so discount/promote
// can act on listings that were already live before this app's real API
// integration existed.
export async function POST() {
  const items = await prisma.item.findMany({
    where: { status: "exported", ebayListingId: null },
    select: { id: true, sku: true },
  });
  if (items.length === 0) {
    return NextResponse.json({ checked: 0, linked: 0, notFound: 0 });
  }

  const found = await findListingsBySku(items.map((i) => i.sku));
  const environment = getEbayEnvironment();

  let linked = 0;
  for (const item of items) {
    const listingId = found.get(item.sku);
    if (!listingId) continue;
    await prisma.item.update({
      where: { id: item.id },
      // ebaySku is the first 50 chars of the raw app sku, NOT the full
      // string — eBay silently truncates SKU/CustomLabel to 50 characters
      // (confirmed: findListingsBySku had to truncate its query the same
      // way to get any matches at all), so that's what's actually on the
      // live listing and what a real order's line item sku will contain.
      // Storing the untruncated version here would silently never match
      // any future order.
      // ebayEnvironment is recorded too so listingUrl() resolves the right
      // domain later — these are always real listings from whichever
      // environment the app is currently pointed at (File Exchange has no
      // sandbox equivalent), same as a fresh publish would set it.
      data: { ebayListingId: listingId, ebaySku: item.sku.slice(0, 50), ebayEnvironment: environment },
    });
    linked++;
  }

  return NextResponse.json({ checked: items.length, linked, notFound: items.length - linked });
}
