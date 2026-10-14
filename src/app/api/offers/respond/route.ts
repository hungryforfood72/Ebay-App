import { ownerOnly } from "@/lib/auth";
import { EbayApiError, SELLER_RESPONSE_MAX, respondToBestOffer } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const ACTIONS = ["Accept", "Decline", "Counter"] as const;
type Action = (typeof ACTIONS)[number];

// Owner only: accept, decline or counter one buyer's Best Offer, with an
// optional note the buyer sees.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const action = body.action as Action;
  const bestOfferId = String(body.bestOfferId ?? "");
  const listingId = String(body.listingId ?? "");
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : null;
  if (!ACTIONS.includes(action) || !bestOfferId || !listingId) {
    return NextResponse.json({ error: "Missing the offer or what to do with it." }, { status: 400 });
  }
  if (message && message.length > SELLER_RESPONSE_MAX) {
    return NextResponse.json({ error: `eBay caps the note at ${SELLER_RESPONSE_MAX} characters.` }, { status: 400 });
  }

  // Same scope as the list: only listings this app tracks.
  const item = await prisma.item.findFirst({ where: { ebayListingId: listingId, status: { in: ["listed", "exported"] } } });
  if (!item) {
    return NextResponse.json({ error: "That listing isn't one this app tracks, or it isn't live." }, { status: 400 });
  }

  let counterPrice: number | undefined;
  let counterQuantity: number | undefined;
  if (action === "Counter") {
    counterPrice = Math.round(Number(body.counterPrice) * 100) / 100;
    counterQuantity = Math.max(1, Math.floor(Number(body.counterQuantity) || 1));
    const listPrice = item.price != null ? Number(item.price) : null;
    if (!Number.isFinite(counterPrice) || counterPrice <= 0) {
      return NextResponse.json({ error: "Enter a counter price." }, { status: 400 });
    }
    if (listPrice != null && counterPrice >= listPrice) {
      return NextResponse.json({ error: `A counter has to be under the $${listPrice.toFixed(2)} list price.` }, { status: 400 });
    }
    const available = item.quantity - item.soldQuantity;
    if (counterQuantity > available) {
      return NextResponse.json({ error: `Only ${available} left on this listing.` }, { status: 400 });
    }
  }

  try {
    await respondToBestOffer({ listingId, bestOfferId, action, sellerResponse: message, counterPrice, counterQuantity });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof EbayApiError || e instanceof Error ? e.message : "eBay didn't take that response.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
