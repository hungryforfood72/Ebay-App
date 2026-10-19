import { requireUser } from "@/lib/auth";
import { printLabelForOrder } from "@/lib/warehouse/shippingLabels";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// A packing slip scanned on Pick orders: prints that order's shipping label
// at the packing station. { orderId, force?, assignLabelId? }
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    if (typeof body.orderId !== "string" || !body.orderId.trim()) {
      return NextResponse.json({ error: "Send orderId." }, { status: 400 });
    }
    return NextResponse.json(
      await printLabelForOrder({
        orderId: body.orderId,
        by: user.username,
        force: body.force === true,
        assignLabelId: typeof body.assignLabelId === "string" ? body.assignLabelId : null,
      })
    );
  } catch (e) {
    return errorResponse(e);
  }
}
