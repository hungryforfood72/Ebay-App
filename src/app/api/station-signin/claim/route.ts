import { logActivity } from "@/lib/activityLog";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkPin } from "@/lib/stationSignIn";
import { normalizeSignInCode } from "@/lib/stationSignInCode";
import { NextResponse } from "next/server";

// The handheld's PIN for a scanned station code. Right PIN = the code is
// this person's; the station PC signs in as them on its next check
// (GET /api/station-pc/code).
export async function POST(request: Request) {
  const user = requireUser(request);
  const body = await request.json().catch(() => ({}));
  const code = normalizeSignInCode(String(body.code ?? ""));
  const pin = String(body.pin ?? "");
  const row = await prisma.stationSignIn.findUnique({
    where: { code },
    select: { id: true, expiresAt: true, claimedById: true, station: { select: { id: true, name: true } } },
  });
  if (!row || row.claimedById || row.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "That code ran out. Scan the station screen again." }, { status: 410 });
  }
  const check = await checkPin(user.id, pin);
  if (!check.ok) {
    await logActivity(
      { request },
      { action: "auth.pin_failed", summary: `Wrong PIN signing in at ${row.station.name}`, targetType: "user", targetId: user.username }
    );
    return NextResponse.json({ error: check.error }, { status: check.status });
  }
  const { count } = await prisma.stationSignIn.updateMany({
    where: { id: row.id, claimedById: null, expiresAt: { gt: new Date() } },
    data: { claimedById: user.id, claimedAt: new Date() },
  });
  if (count === 0) {
    return NextResponse.json({ error: "Someone else just used that code. Scan the station screen again." }, { status: 409 });
  }
  return NextResponse.json({ stationId: row.station.id, stationName: row.station.name });
}
