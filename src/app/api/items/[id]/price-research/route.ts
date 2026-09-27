import { EbayApiError, searchActiveListings } from "@/lib/ebay";
import { detectPackSize, isResellerLot, summarizeComps } from "@/lib/packSize";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const maxDuration = 30;

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

  // Everything here is priced for what this listing actually is: a 3-pack
  // item is compared against 3-pack listings and 3 units' worth of retail.
  // Until 2026-09-27 it took one median across every comp (singles, 2-packs,
  // 8-packs mixed) and set it against one unit's retail, so a Sun Bum
  // 3-pack showed a $24 "median" next to $18.99 retail, neither of which
  // was the price of a 3-pack.
  const packSize = item.isMultipack && item.packSize ? item.packSize : 1;

  const retailLine = item.manifestId && item.upc
    ? await prisma.manifestLine.findFirst({
        where: { manifestId: item.manifestId, upc: item.upc },
        select: { retailPrice: true },
      })
    : null;
  const unitRetail = retailLine ? Number(retailLine.retailPrice) : null;
  const retailPrice = unitRetail != null ? unitRetail * packSize : null;

  try {
    const comps = await searchActiveListings({
      upc: item.upc,
      keywords: keywords ?? "",
      excludeListingId: item.ebayListingId,
    });
    const samePack = comps.filter((c) => {
      const size = detectPackSize(c.title);
      return size === packSize && !isResellerLot(c.title, size);
    });

    if (samePack.length > 0) {
      const totals = samePack.map((c) => c.totalPrice).sort((a, b) => a - b);
      const mid = Math.floor(totals.length / 2);
      const median = totals.length % 2 === 0 ? (totals[mid - 1] + totals[mid]) / 2 : totals[mid];
      return NextResponse.json({
        comps: samePack.slice(0, 10),
        count: totals.length,
        median,
        low: totals[0],
        high: totals[totals.length - 1],
        basis: "same_pack",
        packSize,
        retailPrice,
        unitRetail,
      });
    }

    // Nobody lists this pack size: scale the per-unit median across every
    // other pack size up to this one, labeled as an estimate.
    const summary = summarizeComps(comps);
    return NextResponse.json({
      comps: [],
      count: summary.activeCompCount,
      median: summary.activeCompCount > 0 ? summary.medianPerUnit * packSize : null,
      low: null,
      high: null,
      basis: "scaled",
      packSize,
      retailPrice,
      unitRetail,
    });
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Price research failed.";
    return NextResponse.json({ error: message, retailPrice, unitRetail, packSize }, { status: 502 });
  }
}
