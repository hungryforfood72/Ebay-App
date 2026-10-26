import { logActivity } from "@/lib/activityLog";
import { mailerConfigured } from "@/lib/mailer";
import { FORGOT_HOURS, canSendForgotEmail, createResetLink, originOf, sendPasswordEmail } from "@/lib/passwordReset";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// "Forgot password?" on the sign-in page, reachable signed out. Always the
// same answer, whether or not the username exists or has an email, so it
// can't be used to find out who works here.
const SAME_ANSWER = "If that username has an email on file, a link to set a new password is on its way. No email? Ask the owner.";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  if (!username) return NextResponse.json({ error: "Type your username." }, { status: 400 });
  if (!mailerConfigured()) {
    return NextResponse.json({ error: "Email isn't set up in this app yet. Ask the owner to reset your password." }, { status: 503 });
  }

  // Usernames are typed by hand on a phone: match regardless of case.
  const user = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
    select: { id: true, username: true, email: true },
  });
  if (user?.email && (await canSendForgotEmail(user.id))) {
    const { url } = await createResetLink(user.id, originOf(request), FORGOT_HOURS, "self");
    try {
      await sendPasswordEmail({ to: user.email, username: user.username, url, hours: FORGOT_HOURS, invite: false });
      await logActivity({ request, username: user.username }, { action: "user.password_link", summary: `Forgot password: link emailed to ${user.username}`, targetType: "user", targetId: user.username });
    } catch (e) {
      console.error("[forgot password]", e);
      return NextResponse.json({ error: "Couldn't send the email right now. Try again in a bit, or ask the owner." }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true, message: SAME_ANSWER });
}
