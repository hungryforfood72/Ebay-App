import { logActivity } from "@/lib/activityLog";
import { ownerOnly } from "@/lib/auth";
import { INVITE_HOURS, createResetLink, originOf, sendPasswordEmail } from "@/lib/passwordReset";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// Owner, from Settings > Users: a set-your-password link for someone.
//   { send: true }  emails it to the address on file
//   { send: false } just returns it, to copy and text
// Either way the link comes back, and any older link of theirs stops
// working. See src/lib/passwordReset.ts.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const send = body.send === true;
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, email: true } });
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (send && !target.email) return NextResponse.json({ error: `Add ${target.username}'s email first.` }, { status: 400 });

  const by = request.headers.get("x-username") ?? "owner";
  const { url, expiresAt } = await createResetLink(target.id, originOf(request), INVITE_HOURS, `owner:${by}`);
  if (send) {
    try {
      await sendPasswordEmail({ to: target.email!, username: target.username, url, hours: INVITE_HOURS, invite: true });
    } catch (e) {
      console.error("[password link]", e);
      const reason = e instanceof Error ? e.message : "unknown error";
      return NextResponse.json({ error: `Couldn't send the email (${reason}). Use Copy link and text it instead.`, url, expiresAt }, { status: 502 });
    }
  }
  await logActivity(
    { request },
    {
      action: "user.password_link",
      summary: send ? `Emailed ${target.username} a set-password link (${target.email})` : `Made a set-password link for ${target.username} (copied)`,
      targetType: "user",
      targetId: target.username,
    }
  );
  return NextResponse.json({ ok: true, sentTo: send ? target.email : null, url, expiresAt });
}
