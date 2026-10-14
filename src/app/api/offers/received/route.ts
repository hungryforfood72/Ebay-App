import { ownerOnly } from "@/lib/auth";
import { pendingBuyerOffers } from "@/lib/buyerOffers";
import { EbayApiError } from "@/lib/ebay";
import { NextResponse } from "next/server";

export const maxDuration = 30;

// Owner only: pending Best Offers buyers sent on app listings, with what
// each would leave after fees, a label to the buyer's zone and item cost.
export async function GET(request: Request) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await pendingBuyerOffers());
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Couldn't load buyer offers.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
