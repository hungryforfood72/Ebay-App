import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, createSession, deleteSession, getRequestUser, getUserForSessionToken, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/activityLog";
import { STATION_DEVICE_COOKIE, stationForDevice } from "@/lib/stationSignIn";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days — matches createSession's own expiry

// "Who am I" — client components read this to conditionally render (hide
// the Settings link, show/hide financial numbers already stripped
// server-side elsewhere, show a "Signed in as X" line). Reads straight
// from the headers proxy.ts already set for this request, no extra DB
// lookup needed.
export async function GET(request: Request) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json(user);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  // Same generic error whether the username doesn't exist or the password
  // is wrong — doesn't tell an attacker which one they got right.
  if (!user || !(await verifyPassword(password, user.passwordHash, user.passwordSalt))) {
    await logActivity(
      { request, username },
      { action: "auth.login_failed", summary: `Failed sign-in as "${username}"${user ? " (wrong password)" : " (no such user)"}`, targetType: "user", targetId: username }
    );
    return NextResponse.json({ error: "Wrong username or password." }, { status: 401 });
  }

  // On a station PC (set up for scanner sign-in), tagged with the station
  // so Sign out on the handheld can end it too.
  const station = await stationForDevice(request);
  const { token, expiresAt } = await createSession(user.id, undefined, station?.id ?? null);
  await logActivity(
    { request, user: { id: user.id, username: user.username, role: user.role } },
    { action: "auth.login", summary: `${user.username} signed in`, targetType: "user", targetId: user.username }
  );

  const res = NextResponse.json({ ok: true, role: user.role });
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
    expires: expiresAt,
    path: "/",
  });
  return res;
}

// Logout — meaningful now that accounts are per-person (a shared computer
// shouldn't stay signed in as whoever used it last). Deletes the session
// row outright rather than just clearing the cookie, so the token can't
// be replayed if it leaked before logout.
export async function DELETE(request: Request) {
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`))
    ?.slice(AUTH_COOKIE_NAME.length + 1);
  if (token) {
    // Who's signing out, before the session row that says so is gone.
    const who = await getUserForSessionToken(token);
    await deleteSession(token);
    if (who) await logActivity({ request, user: who }, { action: "auth.logout", summary: `${who.username} signed out`, targetType: "user", targetId: who.username });
  }

  // A station PC set up for scanner sign-in goes to its scan screen next
  // (logout() in UserNav.tsx), not the password form.
  const stationPc = request.headers.get("cookie")?.includes(`${STATION_DEVICE_COOKIE}=`) ?? false;
  const res = NextResponse.json({ ok: true, stationPc });
  res.cookies.delete(AUTH_COOKIE_NAME);
  return res;
}
