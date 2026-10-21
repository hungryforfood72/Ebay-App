import { requireUser } from "@/lib/auth";
import { printLabelForOrder } from "@/lib/warehouse/shippingLabels";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// A pick slip scanned on the Shipping page: prints that order's shipping
// label at the station the shipper picked (stationId), or the packing
// station. { orderId, stationId?, force?, assignLabelId? }
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
        stationId: typeof body.stationId === "string" && body.stationId ? body.stationId : null,
      })
    );
  } catch (e) {
    return errorResponse(e);
  }
}
