import { getRequestUser } from "@/lib/auth";
import { unpickUnit, type PickChannel } from "@/lib/warehouse/picking";
import { NextRequest, NextResponse } from "next/server";

// Undoes the latest pick on a line and puts the unit back in its bin. The
// owner can undo anyone's; everyone else only their own.
export async function POST(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const channel = body.channel as PickChannel;
  if ((channel !== "ebay" && channel !== "shopify") || typeof body.orderId !== "string" || typeof body.lineItemId !== "string") {
    return NextResponse.json({ error: "Send orderId, channel and lineItemId." }, { status: 400 });
  }
  const result = await unpickUnit({ channel, orderId: body.orderId, lineItemId: body.lineItemId }, user);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
