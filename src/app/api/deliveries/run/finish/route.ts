import { finishRun } from "@/lib/delivery/deliveries";
import { deliveryErrorResponse } from "@/lib/delivery/http";
import { NextRequest, NextResponse } from "next/server";

// End the route early. Stops not reached go back to ready.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.runId !== "string") return NextResponse.json({ error: "Missing route." }, { status: 400 });
  try {
    await finishRun(body.runId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return deliveryErrorResponse(e, "finish run");
  }
}
