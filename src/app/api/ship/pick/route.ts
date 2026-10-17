import { getRequestUser } from "@/lib/auth";
import { pickUnit, type PickChannel } from "@/lib/warehouse/picking";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Checks one scanned unit against an order line and, if it's the right
// thing, records the pick and takes it off its bin's count. A wrong scan
// is a normal answer (200, ok: false, with what was scanned) so the page
// can say what it is and what's needed instead.
export async function POST(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const channel = body.channel as PickChannel;
  if (
    (channel !== "ebay" && channel !== "shopify") ||
    typeof body.orderId !== "string" ||
    typeof body.lineItemId !== "string" ||
    (typeof body.scannedCode !== "string" && body.manual !== true)
  ) {
    return NextResponse.json({ error: "Send orderId, channel, lineItemId and scannedCode." }, { status: 400 });
  }
  try {
    const result = await pickUnit(
      {
        channel,
        orderId: body.orderId,
        lineItemId: body.lineItemId,
        scannedCode: typeof body.scannedCode === "string" ? body.scannedCode : "",
        binCode: typeof body.binCode === "string" ? body.binCode : null,
        manual: body.manual === true,
      },
      user.username
    );
    return NextResponse.json(result);
  } catch (e) {
    console.error("[ship/pick]", e);
    return NextResponse.json({ error: `Couldn't save the pick: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
