import { getRequestUser } from "@/lib/auth";
import { printPackingSlip } from "@/lib/warehouse/packingSlip";
import type { PickChannel } from "@/lib/warehouse/picking";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// The Packing slip button on /ship's Ready to pack: { channel, orderId }.
// Prints again even if it already printed once.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const channel = body.channel as PickChannel;
  if ((channel !== "ebay" && channel !== "shopify") || typeof body.orderId !== "string") {
    return NextResponse.json({ error: "Send channel and orderId." }, { status: 400 });
  }
  try {
    return NextResponse.json(await printPackingSlip({ channel, orderId: body.orderId, by: getRequestUser(request)?.username ?? null, force: true }));
  } catch (e) {
    console.error("[ship/packing-slip]", e);
    return NextResponse.json({ error: `Couldn't print the packing slip: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
