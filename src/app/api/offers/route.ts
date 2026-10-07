import { ownerOnly } from "@/lib/auth";
import { EbayApiError } from "@/lib/ebay";
import { eligibleOfferListings } from "@/lib/offers";
import { NextResponse } from "next/server";

export const maxDuration = 30;

// Owner only: app-tracked listings eBay says can get an offer to interested
// buyers right now, with what each one cost (see src/lib/offers.ts).
export async function GET(request: Request) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await eligibleOfferListings());
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Couldn't load eligible listings.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
