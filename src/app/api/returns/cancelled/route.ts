import { AuthError, requireUser } from "@/lib/auth";
import { WarehouseError } from "@/lib/warehouse/bins";
import { listCancelledToRelist, relistCancelledOrder } from "@/lib/warehouse/cancelledOrders";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// GET — cancelled orders whose listing had already ended, waiting to be
// relisted (src/lib/warehouse/cancelledOrders.ts). No money: employees see
// this on the Returns page and dashboard.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json(await listCancelledToRelist());
}

// POST { id, stationId } — relists one as a fresh copy; labels print at the
// station.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  try {
    const user = requireUser(request);
    const result = await relistCancelledOrder({
      returnId: String(body.id ?? ""),
      stationId: typeof body.stationId === "string" ? body.stationId : "",
      by: user.username,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
