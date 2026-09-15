import { createAdByListingId, deleteAd, EbayApiError, findAdByListingId, updateAdBid } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

function parseBidPercentage(body: unknown): number | null {
  const value = Number((body as { bidPercentage?: unknown })?.bidPercentage);
  return Number.isFinite(value) && value >= 1 && value <= 100 ? value : null;
}

// Starts promoting one item (eBay Promoted Listings, Cost Per Sale — no
// upfront spend, eBay only takes a fee as a % of the sale price if it
// actually sells while promoted). Deliberately its own explicit action from
// the dashboard, same "human decides, app just executes" philosophy as
// publish-to-ebay.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bidPercentage = parseBidPercentage(await request.json().catch(() => ({})));
  if (bidPercentage == null) {
    return NextResponse.json({ error: "A bid percentage between 1 and 100 is required." }, { status: 400 });
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayListingId) {
    return NextResponse.json({ error: "This item must be published to eBay before it can be promoted." }, { status: 400 });
  }
  if (item.ebayAdId) {
    return NextResponse.json({ error: "Already promoted — use the update-bid action instead." }, { status: 400 });
  }

  try {
    let adId: string;
    let actualBid = bidPercentage;
    try {
      adId = await createAdByListingId(item.ebayListingId, bidPercentage);
    } catch (e) {
      // Some listings already had an active ad from before this app's
      // integration existed (Seller Hub, an earlier manual campaign) —
      // eBay rejects a second one for the same listing. Self-heal by
      // linking the existing ad instead of just failing, same spirit as
      // /api/items/link-legacy for listings themselves.
      if (e instanceof EbayApiError && /already exists/i.test(e.message)) {
        const existing = await findAdByListingId(item.ebayListingId);
        if (!existing) throw e;
        adId = existing.adId;
        actualBid = existing.bidPercentage || bidPercentage;
      } else {
        throw e;
      }
    }
    const updated = await prisma.item.update({
      where: { id },
      data: { ebayAdId: adId, promotedBidPercentage: actualBid, promotedAt: new Date(), ebayPromoteError: null },
    });
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Promote failed.";
    await prisma.item.update({ where: { id }, data: { ebayPromoteError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// Changes the bid % on an item already being promoted.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bidPercentage = parseBidPercentage(await request.json().catch(() => ({})));
  if (bidPercentage == null) {
    return NextResponse.json({ error: "A bid percentage between 1 and 100 is required." }, { status: 400 });
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayAdId) {
    return NextResponse.json({ error: "This item isn't currently being promoted." }, { status: 400 });
  }

  try {
    await updateAdBid(item.ebayAdId, bidPercentage);
    const updated = await prisma.item.update({
      where: { id },
      data: { promotedBidPercentage: bidPercentage, ebayPromoteError: null },
    });
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Bid update failed.";
    await prisma.item.update({ where: { id }, data: { ebayPromoteError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// Stops promoting an item — the listing itself stays live, only the ad is
// removed.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayAdId) {
    return NextResponse.json({ error: "This item isn't currently being promoted." }, { status: 400 });
  }

  try {
    await deleteAd(item.ebayAdId);
    const updated = await prisma.item.update({
      where: { id },
      data: { ebayAdId: null, promotedBidPercentage: null, promotedAt: null, ebayPromoteError: null },
    });
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Stopping promotion failed.";
    await prisma.item.update({ where: { id }, data: { ebayPromoteError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
