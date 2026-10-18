import { followUp } from "@/lib/delivery/deliveries";
import { deliveryErrorResponse } from "@/lib/delivery/http";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Retry whatever didn't go through after a delivery (Shopify, the email).
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const d = await followUp(id);
    return NextResponse.json({ followUpError: d.followUpError });
  } catch (e) {
    return deliveryErrorResponse(e, "follow-up");
  }
}
