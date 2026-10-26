import { AUTH_COOKIE_NAME, getUserForSessionToken } from "@/lib/auth";
import { STATION_DEVICE_COOKIE, STATION_DEVICE_COOKIE_OPTIONS, readCookie, stationForDeviceValue } from "@/lib/stationSignIn";
import { NextResponse } from "next/server";

// Where the station PC's desktop shortcut opens (the installer puts the
// station's sign-in key in it; stationShortcutArgs). Reachable signed out
// (proxy.ts). A good key sets this PC up for scanner sign-in (the
// station_device cookie, src/lib/stationSignIn.ts), then goes to the
// station page if someone's signed in here, else to the QR screen. So a
// station PC never needs a password, even the first time.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const value = url.searchParams.get("d");
  const station = await stationForDeviceValue(value);
  if (!station || !value) {
    // An old shortcut (station deleted or set up again): the normal way in.
    return NextResponse.redirect(new URL("/login", url));
  }
  const signedIn = await getUserForSessionToken(readCookie(request, AUTH_COOKIE_NAME));
  const res = NextResponse.redirect(new URL(signedIn ? `/station/${station.id}` : "/station-pc", url));
  // Already checked: the same "<stationId>.<key>" the cookie holds.
  res.cookies.set(STATION_DEVICE_COOKIE, value, STATION_DEVICE_COOKIE_OPTIONS);
  return res;
}
