import { logActivity } from "@/lib/activityLog";
import { AUTH_COOKIE_NAME, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readCookie } from "@/lib/stationSignIn";
import { NextRequest, NextResponse } from "next/server";

// "Sign out" next to the station on the handheld (Cristian, 2026-10-26):
// ends your sign-in on that station's PC (Session.stationId), which then
// goes back to its QR screen for the next person within a few seconds (the
// station page reloads on a 401). The owner signs out whoever is there.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUser(request);
  const { id } = await params;
  const station = await prisma.station.findUnique({ where: { id }, select: { name: true } });
  if (!station) return NextResponse.json({ error: "That station doesn't exist anymore." }, { status: 404 });

  const where = user.role === "owner" ? { stationId: id } : { stationId: id, userId: user.id };
  const sessions = await prisma.session.findMany({ where, select: { token: true } });
  await prisma.session.deleteMany({ where: { token: { in: sessions.map((s) => s.token) } } });
  // This device was the station PC itself (Sign out on its own page).
  const thisDevice = sessions.some((s) => s.token === readCookie(request, AUTH_COOKIE_NAME));

  if (sessions.length) {
    await logActivity(
      { request },
      { action: "auth.logout", summary: `${user.username} signed out of ${station.name} from the scanner`, targetType: "station", targetId: id }
    );
  }
  return NextResponse.json({ signedOut: sessions.length, thisDevice, stationName: station.name });
}
