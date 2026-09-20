import { AuthError, requireOwner } from "@/lib/auth";
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
  return NextResponse.json({ ok: true });
}
