import { logActivity } from "@/lib/activityLog";
import { AUTH_COOKIE_NAME, createSession } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH, findReset, redeemPasswordReset } from "@/lib/passwordReset";
import { NextResponse } from "next/server";

// The set-your-password page (/login/set/<token>), reachable signed out
// (proxy.ts lets /api/auth* through). See src/lib/passwordReset.ts.

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // same as a password sign-in
const EXPIRED = "This link has expired or was already used. Ask for a new one.";

// Whose link it is, so the page can show the username.
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const row = await findReset(token);
  if (!row) return NextResponse.json({ error: EXPIRED }, { status: 410 });
  return NextResponse.json({ username: row.user.username });
}

// Set the new password; signs them in here and out everywhere else.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const token = String(body.token ?? "");
  const password = String(body.password ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Your password has to be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }
  const user = await redeemPasswordReset(token, password);
  if (!user) return NextResponse.json({ error: EXPIRED }, { status: 410 });

  await logActivity({ request, user }, { action: "user.password_set", summary: `${user.username} set a new password from an email link`, targetType: "user", targetId: user.username });
  const { token: session, expiresAt } = await createSession(user.id);
  const res = NextResponse.json({ ok: true, username: user.username });
  res.cookies.set(AUTH_COOKIE_NAME, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
    expires: expiresAt,
    path: "/",
  });
  return res;
}
