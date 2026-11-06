import { AUTH_COOKIE_NAME, AuthError, requireUser } from "@/lib/auth";
import { WarehouseError } from "@/lib/warehouse/bins";
import {
  goToStationMessage,
  listCancelledToRelist,
  relistCancelledOrder,
  relistStation,
  sessionStationId,
} from "@/lib/warehouse/cancelledOrders";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// GET — cancelled orders whose listing had already ended, waiting to be
// relisted (src/lib/warehouse/cancelledOrders.ts), and whether this
// sign-in is at the station where relisting happens. No money: employees
// see this on the Returns page and dashboard.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const [rows, station, here] = await Promise.all([
    listCancelledToRelist(),
    relistStation(),
    sessionStationId(request.cookies.get(AUTH_COOKIE_NAME)?.value),
  ]);
  const atStation = Boolean(station && here === station.id);
  return NextResponse.json({
    rows,
    atStation,
    stationName: station?.name ?? null,
    ...(atStation ? {} : { goTo: goToStationMessage(station) }),
  });
}

// POST { id } — relists one as a fresh copy. Only from a sign-in at the
// relist station (the Listing Station); the labels print there.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  try {
    const user = requireUser(request);
    const result = await relistCancelledOrder({
      returnId: String(body.id ?? ""),
      sessionStationId: await sessionStationId(request.cookies.get(AUTH_COOKIE_NAME)?.value),
      by: user.username,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
