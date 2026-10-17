import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { newShareToken } from "@/lib/supplierShare";
import { NextRequest, NextResponse } from "next/server";

// Owner controls for the supplier's read-only link (/s/{token}).
// POST makes a new link (replacing any old one, which stops working);
// DELETE turns sharing off.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const manifest = await prisma.manifest.findUnique({ where: { id }, select: { consignment: true } });
  if (!manifest?.consignment) return NextResponse.json({ error: "Only consignment loads can be shared." }, { status: 400 });
  const updated = await prisma.manifest.update({ where: { id }, data: { shareToken: newShareToken() } });
  return NextResponse.json({ shareToken: updated.shareToken });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  await prisma.manifest.update({ where: { id }, data: { shareToken: null } });
  return NextResponse.json({ shareToken: null });
}
