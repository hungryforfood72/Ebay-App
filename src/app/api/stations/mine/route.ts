import { requireUser } from "@/lib/auth";
import { stationForUser } from "@/lib/stationSignIn";
import { NextRequest, NextResponse } from "next/server";

// The station this device works at when it hasn't remembered one
// (Cristian, 2026-10-26: stations change only by scanning a station's QR,
// no picking from a list):
//   - this browser IS a station PC (its station_device cookie), or
//   - you're signed in at a station PC right now (Session.stationId), so a
//     handheld that lost its station finds it again by itself.
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  const station = await stationForUser(request, user.id);
  return NextResponse.json({ stationId: station?.id ?? null, stationName: station?.name ?? null, via: station?.via ?? null });
}
