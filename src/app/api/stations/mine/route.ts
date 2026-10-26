import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stationForDevice } from "@/lib/stationSignIn";
import { NextRequest, NextResponse } from "next/server";

// The station this device works at when it hasn't remembered one
// (Cristian, 2026-10-26: stations change only by scanning a station's QR,
// no picking from a list):
//   - this browser IS a station PC (its station_device cookie), or
//   - you're signed in at a station PC right now (Session.stationId), so a
//     handheld that lost its station finds it again by itself.
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  const pc = await stationForDevice(request);
  if (pc) return NextResponse.json({ stationId: pc.id, via: "this-pc" });
  const session = await prisma.session.findFirst({
    where: { userId: user.id, stationId: { not: null }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { stationId: true },
  });
  return NextResponse.json({ stationId: session?.stationId ?? null, via: session ? "signed-in" : null });
}
