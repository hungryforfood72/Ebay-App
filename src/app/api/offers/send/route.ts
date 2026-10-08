import { ownerOnly } from "@/lib/auth";
import { cogsMapsFor, costPerListingUnit } from "@/lib/cogs";
import { EbayApiError, sendOfferToInterestedBuyers } from "@/lib/ebay";
import { MAX_OFFER_PERCENT, MIN_OFFER_PERCENT, offerOutcome } from "@/lib/offerMath";
import { prisma } from "@/lib/prisma";
import { typicalSingleLabelCost } from "@/lib/shippingCost";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Owner only: sends one listing's offer to all its interested buyers. The
// dashboard calls this once per listing ("send to all" loops), since eBay
// takes one listing per request.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const discountPercent = Number(body.discountPercent);
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : null;
  if (!Number.isFinite(discountPercent) || discountPercent < MIN_OFFER_PERCENT || discountPercent > MAX_OFFER_PERCENT) {
    return NextResponse.json(
      { error: `eBay offers have to be between ${MIN_OFFER_PERCENT}% and ${MAX_OFFER_PERCENT}% off.` },
      { status: 400 }
    );
  }

  const item = await prisma.item.findUnique({ where: { id: String(body.itemId ?? "") } });
  // Same scope as the list: only listings this app tracks.
  if (!item || !item.ebayListingId || !["listed", "exported"].includes(item.status) || item.price == null) {
    return NextResponse.json({ error: "That listing isn't one this app tracks, or it isn't live." }, { status: 400 });
  }

  // Never send an offer that loses money on a costed item, even if the
  // page was stale or the request came from somewhere else.
  const cogsMaps = await cogsMapsFor([item.manifestId]);
  const { cost, costed } = costPerListingUnit(item, cogsMaps);
  const { offerPrice, profit } = offerOutcome(
    {
      listPrice: Number(item.price),
      unitCost: costed ? cost : null,
      labelCost: item.localPickupOnly ? 0 : await typicalSingleLabelCost(),
      promotedPercent: item.ebayAdId ? item.promotedBidPercentage : null,
    },
    discountPercent
  );
  if (costed && profit < 0) {
    return NextResponse.json(
      { error: `At ${discountPercent}% off ($${offerPrice.toFixed(2)}) this would lose $${(-profit).toFixed(2)} a sale.` },
      { status: 400 }
    );
  }

  try {
    const buyerCount = await sendOfferToInterestedBuyers({ listingId: item.ebayListingId, discountPercent, message });
    const sent = await prisma.sentOffer.create({
      data: {
        itemId: item.id,
        listingId: item.ebayListingId,
        discountPercent,
        listPrice: item.price,
        offerPrice,
        buyerCount,
        message,
      },
    });
    return NextResponse.json({ buyerCount, offerPrice, sentAt: sent.sentAt.toISOString() });
  } catch (e) {
    const msg = e instanceof EbayApiError || e instanceof Error ? e.message : "Sending the offer failed.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
