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

  try {
    const comps = await searchActiveListings({
      upc: item.upc,
      keywords: keywords ?? "",
      excludeListingId: item.ebayListingId,
    });
    if (comps.length === 0) {
      return NextResponse.json({ comps: [], median: null, low: null, high: null });
    }
    const prices = comps.map((c) => c.price).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
    return NextResponse.json({
      comps: comps.slice(0, 10),
      count: comps.length,
      median,
      low: prices[0],
      high: prices[prices.length - 1],
    });
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Price research failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
