import { EbayApiError } from "@/lib/ebay";
import { getPickList } from "@/lib/warehouse/picking";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Open orders to pick for /ship, in walking order (shelf, then bin). Any
// signed-in user: it has no money in it. ?fresh=1 skips the short cache
// (the Refresh button), so an order that just came in shows up right away.
export async function GET(request: NextRequest) {
  try {
    const fresh = request.nextUrl.searchParams.get("fresh") === "1";
    return NextResponse.json(await getPickList({ fresh }));
  } catch (e) {
    console.error("[ship/orders]", e);
    const message =
      e instanceof EbayApiError
        ? `eBay didn't answer: ${e.message}`
        : `Couldn't load orders: ${e instanceof Error ? e.message : String(e)}`;
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
