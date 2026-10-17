import { getLiveAvailableQuantity, getOfferDetails } from "@/lib/ebay";
import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { adjustItemStock } from "@/lib/stockAdjust";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Live, authoritative check of what's actually available on the real eBay
// listing right now — the whole point of this route existing separately
// from the item's own GET is that the DB's own availableQuantity can be
// stale (see the ItemForEbayPublish comment in ebay.ts for the confirmed
// real bug this shipped alongside: a partially-sold listing's live
// quantity could silently get reset by an unrelated price update). Works
// for both kinds of listing (see getLiveAvailableQuantity); live price is
// only read for Inventory-API listings.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }

  const storedAvailableQuantity = Math.max(0, item.quantity - item.soldQuantity);

  const recentAdjustments = await prisma.stockAdjustment.findMany({
    where: { itemId: id },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  // Off eBay (Shopify & Whatnot only, or moved to the past-date page): the
  // app's own count is the only one.
  if (item.shopifyOnly || item.pastDateAt) {
    return NextResponse.json({
      liveAvailableQuantity: null,
      livePrice: null,
      storedAvailableQuantity,
      recentAdjustments,
    });
  }

  if (!item.ebayOfferId) {
    return NextResponse.json({
      liveAvailableQuantity: await getLiveAvailableQuantity(item),
      livePrice: null,
      storedAvailableQuantity,
      recentAdjustments,
    });
  }

  const live = await getOfferDetails(item.ebayOfferId);
  return NextResponse.json({
    liveAvailableQuantity: live?.availableQuantity ?? null,
    livePrice: live?.price ?? null,
    storedAvailableQuantity,
    recentAdjustments,
  });
}

// Adds or removes stock by a signed delta, with a required note. The logic
// (and why it's a delta checked against live eBay at write time) lives in
// src/lib/stockAdjust.ts, shared with same-condition returns.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const result = await adjustItemStock({
    itemId: id,
    direction: body.direction,
    amount: body.amount,
    note: body.note,
    recordedBy: getRequestUser(request)?.username ?? null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.body);
}
