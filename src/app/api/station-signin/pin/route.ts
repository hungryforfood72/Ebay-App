import { logActivity } from "@/lib/activityLog";
import { requireUser, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { setPin } from "@/lib/stationSignIn";
import { PIN_PATTERN } from "@/lib/stationSignInCode";
import { NextResponse } from "next/server";

// Whether the signed-in person has a PIN for signing in at stations.
export async function GET(request: Request) {
  const user = requireUser(request);
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { pinHash: true } });
  return NextResponse.json({ hasPin: Boolean(me?.pinHash) });
}

// Set or change your own PIN. Takes your password, so a handheld someone
// left signed in can't be used to set a PIN for them.
export async function POST(request: Request) {
  const user = requireUser(request);
  const body = await request.json().catch(() => ({}));
  const password = String(body.password ?? "");
  const pin = String(body.pin ?? "");
  if (!PIN_PATTERN.test(pin)) return NextResponse.json({ error: "Your PIN has to be 4 to 6 numbers." }, { status: 400 });
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true, passwordSalt: true } });
  if (!me || !(await verifyPassword(password, me.passwordHash, me.passwordSalt))) {
    return NextResponse.json({ error: "That's not your password." }, { status: 401 });
  }
  await setPin(user.id, pin);
  await logActivity({ request }, { action: "user.pin_set", summary: `${user.username} set their station PIN`, targetType: "user", targetId: user.username });
  return NextResponse.json({ ok: true });
}
