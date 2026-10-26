import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeSignInCode } from "@/lib/stationSignInCode";
import { NextResponse } from "next/server";

// The handheld just scanned a station's sign-in code: which station it is,
// and whether this person has a PIN yet (if not, they set one up first).
export async function POST(request: Request) {
  const user = requireUser(request);
  const body = await request.json().catch(() => ({}));
  const code = normalizeSignInCode(String(body.code ?? ""));
  const row = await prisma.stationSignIn.findUnique({
    where: { code },
    select: { expiresAt: true, claimedById: true, station: { select: { id: true, name: true } } },
  });
  if (!row || row.claimedById || row.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "That code ran out. Scan the station screen again." }, { status: 410 });
  }
  // So the PC can say who's signing in, and check more often meanwhile.
  await prisma.stationSignIn.update({ where: { code }, data: { scannedAt: new Date(), scannedBy: user.username } });
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { pinHash: true } });
  return NextResponse.json({
    stationId: row.station.id,
    stationName: row.station.name,
    username: user.username,
    hasPin: Boolean(me?.pinHash),
  });
}
