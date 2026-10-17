import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { saveBoxSize } from "@/lib/warehouse/boxSizes";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Owner only (Settings). Body: any of { label, code, tareOz, lengthIn,
// widthIn, heightIn }; fields left out stay as they are, blank numbers
// clear.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await saveBoxSize(id, body));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  await prisma.boxSize.deleteMany({ where: { id } });
  return NextResponse.json({ ok: true });
}
