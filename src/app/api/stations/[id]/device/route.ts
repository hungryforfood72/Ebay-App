import { requireUser } from "@/lib/auth";
import {
  STATION_DEVICE_COOKIE,
  STATION_DEVICE_COOKIE_OPTIONS,
  ensureSignInKey,
  stationDeviceCookieValue,
  stationForDevice,
} from "@/lib/stationSignIn";
import { NextRequest, NextResponse } from "next/server";

// Scanner sign-in on a station PC (src/lib/stationSignIn.ts). Turned on
// per PC from the station page, not just by opening it: Cristian's own PC
// and the handhelds open station pages too, and they should keep the
// normal password sign-in.

// Is this PC (this browser) set up as this station?
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  requireUser(request);
  const { id } = await params;
  const station = await stationForDevice(request);
  return NextResponse.json({ thisStation: station?.id === id, otherStation: station && station.id !== id ? station.name : null });
}

// Turn it on: after a log out, this PC shows the scan-to-sign-in screen
// (/station-pc) instead of the password form.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  requireUser(request);
  const { id } = await params;
  const key = await ensureSignInKey(id);
  if (!key) return NextResponse.json({ error: "That station doesn't exist anymore." }, { status: 404 });
  const res = NextResponse.json({ thisStation: true, otherStation: null });
  res.cookies.set(STATION_DEVICE_COOKIE, stationDeviceCookieValue(id, key), STATION_DEVICE_COOKIE_OPTIONS);
  return res;
}

// Turn it off on this PC.
export async function DELETE(request: NextRequest) {
  requireUser(request);
  const res = NextResponse.json({ thisStation: false, otherStation: null });
  res.cookies.delete(STATION_DEVICE_COOKIE);
  return res;
}
