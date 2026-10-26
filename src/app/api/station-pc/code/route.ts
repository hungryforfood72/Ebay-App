import { logActivity } from "@/lib/activityLog";
import { AUTH_COOKIE_NAME, createSession, deleteSession, getUserForSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { STATION_SESSION_MS, newSignInCode, readCookie, stationForDevice } from "@/lib/stationSignIn";
import { normalizeSignInCode } from "@/lib/stationSignInCode";
import { NextResponse } from "next/server";

// The station PC's sign-in screen (/station-pc), reachable signed out
// (proxy.ts). Only a PC holding the station's station_device cookie gets
// anywhere. See stationSignIn.ts for the whole flow.

const NOT_A_STATION = "This PC isn't set up as a station yet. Sign in with your password and open the station page once.";

// A fresh code to show.
export async function POST(request: Request) {
  const station = await stationForDevice(request);
  if (!station) return NextResponse.json({ error: NOT_A_STATION }, { status: 403 });
  const { code, expiresAt } = await newSignInCode(station.id);
  return NextResponse.json({ code, expiresAt, stationId: station.id, stationName: station.name });
}

// Has someone scanned this code and put their PIN in? If so, this PC is
// signed in as them from this response on.
export async function GET(request: Request) {
  const station = await stationForDevice(request);
  if (!station) return NextResponse.json({ error: NOT_A_STATION }, { status: 403 });
  const code = normalizeSignInCode(new URL(request.url).searchParams.get("code") ?? "");
  const row = await prisma.stationSignIn.findUnique({
    where: { code },
    select: {
      id: true,
      stationId: true,
      expiresAt: true,
      usedAt: true,
      scannedAt: true,
      scannedBy: true,
      claimedBy: { select: { id: true, username: true, role: true } },
    },
  });
  if (!row || row.stationId !== station.id || row.usedAt) return NextResponse.json({ status: "expired" });
  const user = row.claimedBy;
  if (!user) {
    if (row.expiresAt.getTime() < Date.now()) return NextResponse.json({ status: "expired" });
    return NextResponse.json({ status: "waiting", scannedBy: row.scannedBy, scannedAt: row.scannedAt });
  }
  // Exactly one check gets to use it, even with two tabs open.
  const { count } = await prisma.stationSignIn.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (count === 0) return NextResponse.json({ status: "expired" });

  // Whoever was signed in here before (if anyone) is signed out of this PC.
  const previousToken = readCookie(request, AUTH_COOKIE_NAME);
  if (previousToken) {
    const previous = await getUserForSessionToken(previousToken);
    await deleteSession(previousToken);
    if (previous && previous.id !== user.id) {
      await logActivity(
        { request, user: previous },
        {
          action: "auth.logout",
          summary: `${previous.username} signed out of ${station.name} (${user.username} signed in)`,
          targetType: "user",
          targetId: previous.username,
        }
      );
    }
  }

  const { token, expiresAt } = await createSession(user.id, STATION_SESSION_MS, station.id);
  await logActivity(
    { request, user },
    { action: "auth.login", summary: `${user.username} signed in at ${station.name} (scanner + PIN)`, targetType: "user", targetId: user.username }
  );
  const res = NextResponse.json({ status: "signed-in", username: user.username, stationId: station.id });
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: Math.floor(STATION_SESSION_MS / 1000),
    expires: expiresAt,
    path: "/",
  });
  return res;
}
