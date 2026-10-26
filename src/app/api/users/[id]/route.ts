import { logActivity } from "@/lib/activityLog";
import { AuthError, requireOwner } from "@/lib/auth";
import { looksLikeEmail } from "@/lib/passwordReset";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let owner;
  try {
    owner = requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  if (id === owner.id) {
    return NextResponse.json({ error: "Can't delete your own account while signed in as it." }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }
  if (target.role === "owner") {
    const ownerCount = await prisma.user.count({ where: { role: "owner" } });
    if (ownerCount <= 1) {
      return NextResponse.json({ error: "Can't delete the last owner account." }, { status: 400 });
    }
  }

  // Sessions cascade automatically (Session.user has onDelete: Cascade) —
  // deleting the user immediately signs them out everywhere.
  await prisma.user.delete({ where: { id } });
  await logActivity({ request }, { action: "user.delete", summary: `Deleted ${target.role} account "${target.username}"`, targetType: "user", targetId: target.username, before: { username: target.username, role: target.role } });
  return NextResponse.json({ ok: true });
}

// Owner, any of:
//   clearPin: true  clear their station PIN (forgotten, or locked out);
//                   they set a new one with their password next scan
//   email: string   where set-password links go ("" removes it)
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const target = await prisma.user.findUnique({ where: { id }, select: { username: true, email: true } });
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (typeof body.email === "string") {
    const email = body.email.trim() || null;
    if (email && !looksLikeEmail(email)) return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
    await prisma.user.update({ where: { id }, data: { email } });
    await logActivity(
      { request },
      { action: "user.email", summary: `${target.username}'s email: ${email ?? "removed"}`, targetType: "user", targetId: target.username, before: { email: target.email }, after: { email } }
    );
    return NextResponse.json({ ok: true, email });
  }
  if (body.clearPin !== true) return NextResponse.json({ error: "Send clearPin: true or email." }, { status: 400 });
  await prisma.user.update({ where: { id }, data: { pinHash: null, pinSalt: null, pinFailures: 0, pinLockedUntil: null } });
  await logActivity({ request }, { action: "user.pin_reset", summary: `Reset ${target.username}'s station PIN`, targetType: "user", targetId: target.username });
  return NextResponse.json({ ok: true });
}
