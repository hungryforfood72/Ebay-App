import { ownerOnly } from "@/lib/auth";
import { cogsMapsFor, costPerListingUnit } from "@/lib/cogs";
import { EbayApiError, getListingStatus, sendOfferToInterestedBuyers } from "@/lib/ebay";
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

  const listingId = String(body.listingId ?? "");
  if (!listingId) return NextResponse.json({ error: "Missing the listing." }, { status: 400 });

  // App-tracked listing: its price and cost come from the app. A listing
  // made before the app has no Item row, so eBay supplies the price and
  // there's no item cost to guard against.
  const item = await prisma.item.findFirst({ where: { ebayListingId: listingId, status: { in: ["listed", "exported"] } } });
  let listPrice: number;
  let unitCost: number | null = null;
  if (item) {
    if (item.price == null) return NextResponse.json({ error: "That listing has no price in the app." }, { status: 400 });
    listPrice = Number(item.price);
    const cogsMaps = await cogsMapsFor([item.manifestId]);
    const { cost, costed } = costPerListingUnit(item, cogsMaps);
    unitCost = costed ? cost : null;
  } else {
    const live = await getListingStatus(listingId).catch(() => null);
    if (!live?.active || live.price == null) {
      return NextResponse.json({ error: "eBay says that listing isn't live." }, { status: 400 });
    }
    listPrice = live.price;
  }

  // Never send an offer that loses money on a costed item, even if the
  // page was stale or the request came from somewhere else.
  const { offerPrice, profit } = offerOutcome(
    {
      listPrice,
      unitCost,
      labelCost: item?.localPickupOnly ? 0 : await typicalSingleLabelCost(),
      promotedPercent: item?.ebayAdId ? item.promotedBidPercentage : null,
    },
    discountPercent
  );
  if (unitCost != null && profit < 0) {
    return NextResponse.json(
      { error: `At ${discountPercent}% off ($${offerPrice.toFixed(2)}) this would lose $${(-profit).toFixed(2)} a sale.` },
      { status: 400 }
    );
  }

  try {
    const buyerCount = await sendOfferToInterestedBuyers({ listingId, discountPercent, message });
    const sent = await prisma.sentOffer.create({
      data: {
        itemId: item?.id ?? null,
        listingId,
        discountPercent,
        listPrice,
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
