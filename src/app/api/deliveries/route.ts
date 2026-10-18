import { getDeliveries } from "@/lib/delivery/deliveries";
import { deliveryErrorResponse } from "@/lib/delivery/http";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// /deliveries: local delivery orders and the route in progress. ?sync=1
// pulls new and changed orders from Shopify first. Any signed-in user:
// employees drive too (Cristian, 2026-10-17), so they see the addresses.
export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(await getDeliveries({ sync: request.nextUrl.searchParams.get("sync") === "1" }));
  } catch (e) {
    return deliveryErrorResponse(e, "load");
  }
}
