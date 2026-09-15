import { EbayApiError, searchActiveListings } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const maxDuration = 30;

// On-demand only — never persisted, never auto-fills Item.price. Shows a
// "based on active competition" estimate next to the review page's price
// field, purely advisory. There's no API path to real sold-price data
// (eBay's Marketplace Insights API is closed to new applicants and the
// public sold-listings page now requires login) — this is deliberately
// framed as "active listings," not "what things sold for."
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }

  const keywords = item.finalTitle ?? item.aiTitle;
  if (!item.upc && !keywords) {
    return NextResponse.json({ error: "Need a UPC or a title to search comps." }, { status: 400 });
  }

  // What the spreadsheet said this cost per unit, if this item came from a
  // manifest scan — lets Cristian see at a glance whether current comps are
  // above or below what he paid. Not recomputed; comes straight from the
  // manifest CSV line, same as the manifest reconciliation dashboard's
  // figures. Same UPC can appear on more than one line (split across
  // pallets) — they're normally the same price, so the first match is fine.
  const retailLine = item.manifestId && item.upc
    ? await prisma.manifestLine.findFirst({
        where: { manifestId: item.manifestId, upc: item.upc },
        select: { retailPrice: true },
      })
    : null;
  const retailPrice = retailLine ? Number(retailLine.retailPrice) : null;

  try {
    const comps = await searchActiveListings({
      upc: item.upc,
      keywords: keywords ?? "",
      excludeListingId: item.ebayListingId,
    });
    if (comps.length === 0) {
      return NextResponse.json({ comps: [], median: null, low: null, high: null, retailPrice });
    }
    // Sorted/summarized on totalPrice (item + real fixed shipping cost) —
    // the actual out-of-pocket price to a buyer, not just the item's own
    // sticker price, so a "free shipping at $20" listing and a "$15 + $5
    // shipping" listing compare as the equivalent deals they are.
    const totals = comps.map((c) => c.totalPrice).sort((a, b) => a - b);
    const mid = Math.floor(totals.length / 2);
    const median = totals.length % 2 === 0 ? (totals[mid - 1] + totals[mid]) / 2 : totals[mid];
    return NextResponse.json({
      comps: comps.slice(0, 10),
      count: comps.length,
      median,
      low: totals[0],
      high: totals[totals.length - 1],
      retailPrice,
    });
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Price research failed.";
    return NextResponse.json({ error: message, retailPrice }, { status: 502 });
  }
}
