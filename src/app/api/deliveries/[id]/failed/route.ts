import { markFailed } from "@/lib/delivery/deliveries";
import { deliveryErrorResponse } from "@/lib/delivery/http";
import { NextRequest, NextResponse } from "next/server";

// Couldn't deliver: { note }. Back to the queue for the next route.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    await markFailed(id, typeof body.note === "string" ? body.note : "");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return deliveryErrorResponse(e, "failed");
  }
}
