import { createHash, randomBytes } from "crypto";
import { hashPassword } from "./auth";
import { sendEmail } from "./mailer";
import { prisma } from "./prisma";

// People set their own passwords (Cristian, 2026-10-26) instead of him
// making one and passing it on. A one-time link to /login/set/<token>:
//   - the owner sends it from Settings > Users (email, or Copy link to
//     text it), good for INVITE_HOURS, e.g. for someone new;
//   - anyone with an email on file asks for one from "Forgot password?"
//     on the sign-in page, good for FORGOT_HOURS.
// Setting the password signs them out everywhere else (the old password
// may have been known to someone) and signs them in on that device.

export const INVITE_HOURS = 72;
export const FORGOT_HOURS = 1;
// "Forgot password?" sends at most one email per person this often, so
// the form can't be used to flood someone's inbox.
const FORGOT_MIN_GAP_MS = 2 * 60 * 1000;

export const MIN_PASSWORD_LENGTH = 8;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createResetLink(
  userId: string,
  origin: string,
  hours: number,
  requestedBy: string
): Promise<{ url: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  // Old unused links for this person stop working: only the newest counts.
  await prisma.passwordReset.deleteMany({ where: { userId, usedAt: null } });
  await prisma.passwordReset.create({ data: { tokenHash: hashToken(token), userId, expiresAt, requestedBy } });
  return { url: `${origin}/login/set/${token}`, expiresAt };
}

// The link's person, if it's still good.
export async function findReset(token: string) {
  if (!token) return null;
  const row = await prisma.passwordReset.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, expiresAt: true, usedAt: true, user: { select: { id: true, username: true, role: true } } },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

// Sets the password from a link. Returns the person, or null if the link
// is no good (used, expired, replaced by a newer one).
export async function redeemPasswordReset(token: string, password: string) {
  const row = await findReset(token);
  if (!row) return null;
  const { count } = await prisma.passwordReset.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (count === 0) return null;
  const { hash, salt } = await hashPassword(password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.user.id }, data: { passwordHash: hash, passwordSalt: salt } }),
    prisma.session.deleteMany({ where: { userId: row.user.id } }),
    prisma.passwordReset.deleteMany({ where: { userId: row.user.id, usedAt: null } }),
  ]);
  return row.user;
}

// Whether "Forgot password?" may send this person another email yet.
export async function canSendForgotEmail(userId: string): Promise<boolean> {
  const recent = await prisma.passwordReset.findFirst({
    where: { userId, requestedBy: "self", createdAt: { gt: new Date(Date.now() - FORGOT_MIN_GAP_MS) } },
    select: { id: true },
  });
  return !recent;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendPasswordEmail(opts: { to: string; username: string; url: string; hours: number; invite: boolean }) {
  const { to, username, url, hours, invite } = opts;
  const lasts = hours >= 24 ? `${Math.round(hours / 24)} days` : hours === 1 ? "1 hour" : `${hours} hours`;
  const intro = invite
    ? "Set your own password for the Epic Steals work app (the eBay Tool) with the button below."
    : "Someone asked to reset your password for the Epic Steals work app (the eBay Tool). If that was you, use the button below. If not, you can ignore this email.";
  const text = [
    `Hi ${username},`,
    "",
    intro,
    "",
    url,
    "",
    `Your username is: ${username}`,
    `The link works once and for ${lasts}.`,
  ].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#18181b;max-width:480px">
<p>Hi ${escapeHtml(username)},</p>
<p>${escapeHtml(intro)}</p>
<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">Set my password</a></p>
<p>Your username is: <b>${escapeHtml(username)}</b><br>The link works once and for ${lasts}.</p>
<p style="color:#71717a;font-size:13px">Button not working? Copy this into your browser:<br>${escapeHtml(url)}</p>
</div>`;
  await sendEmail({ to, subject: invite ? "Set your password for the eBay Tool" : "Reset your eBay Tool password", html, text });
}

// Loose check: something@something.something. The email itself proves it.
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// The site's own address, for links in emails: the request's origin.
export function originOf(request: Request): string {
  return new URL(request.url).origin;
}
