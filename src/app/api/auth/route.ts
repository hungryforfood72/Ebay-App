import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, createSession, deleteSession, getRequestUser, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
    return NextResponse.json({ error: "Wrong username or password." }, { status: 401 });
  }

  const { token, expiresAt } = await createSession(user.id);

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
  if (token) await deleteSession(token);

  const res = NextResponse.json({ ok: true });
  res.cookies.delete(AUTH_COOKIE_NAME);
  return res;
}
