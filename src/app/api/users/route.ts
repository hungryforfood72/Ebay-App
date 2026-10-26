import { logActivity } from "@/lib/activityLog";
import { AuthError, hashPassword, requireOwner } from "@/lib/auth";
import { mailerConfigured } from "@/lib/mailer";
import { INVITE_HOURS, MIN_PASSWORD_LENGTH, createResetLink, looksLikeEmail, originOf, sendPasswordEmail } from "@/lib/passwordReset";
import { prisma } from "@/lib/prisma";
import { randomBytes } from "crypto";
import { NextResponse } from "next/server";

// Also gated at the proxy.ts layer (/api/users is in its ownerOnlyPrefixes)
// — requireOwner here is defense in depth, not the only check, per the
// Next.js docs' own warning not to rely on proxy alone.
export async function GET(request: Request) {
  try {
    requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const rows = await prisma.user.findMany({
    select: { id: true, username: true, role: true, createdAt: true, email: true, pinHash: true, pinLockedUntil: true },
    orderBy: { createdAt: "asc" },
  });
  // The PIN itself never leaves the server: just whether there is one.
  const users = rows.map(({ pinHash, pinLockedUntil, ...u }) => ({
    ...u,
    hasPin: Boolean(pinHash),
    pinLocked: Boolean(pinLockedUntil && pinLockedUntil.getTime() > Date.now()),
  }));
  return NextResponse.json({ users, emailReady: mailerConfigured() });
}

export async function POST(request: Request) {
  try {
    requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = await request.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  const email = String(body.email ?? "").trim() || null;
  const role = body.role === "owner" ? "owner" : "employee";

  // Password or email: with only an email, they get a link to set their
  // own password (src/lib/passwordReset.ts).
  if (!username || (!password && !email)) {
    return NextResponse.json({ error: "Username and a password or email are required." }, { status: 400 });
  }
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }
  if (email && !looksLikeEmail(email)) {
    return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json({ error: `"${username}" is already taken.` }, { status: 400 });
  }

  // No password given: a random one nobody knows, until they set theirs.
  const { hash, salt } = await hashPassword(password || randomBytes(32).toString("hex"));
  const user = await prisma.user.create({
    data: { username, passwordHash: hash, passwordSalt: salt, role, email },
    select: { id: true, username: true, role: true, createdAt: true, email: true },
  });
  await logActivity({ request }, { action: "user.create", summary: `Added ${role} account "${username}"`, targetType: "user", targetId: username, after: { username, role, email } });

  // Invite: email the set-your-password link (the link also comes back,
  // to copy and text if the email didn't go).
  let invite: { sentTo: string | null; url: string; error?: string } | null = null;
  if (!password && email) {
    const by = request.headers.get("x-username") ?? "owner";
    const { url } = await createResetLink(user.id, originOf(request), INVITE_HOURS, `owner:${by}`);
    try {
      await sendPasswordEmail({ to: email, username, url, hours: INVITE_HOURS, invite: true });
      invite = { sentTo: email, url };
      await logActivity({ request }, { action: "user.password_link", summary: `Emailed ${username} a set-password link (${email})`, targetType: "user", targetId: username });
    } catch (e) {
      invite = { sentTo: null, url, error: e instanceof Error ? e.message : "Couldn't send the email." };
    }
  }
  return NextResponse.json({ ...user, invite }, { status: 201 });
}
