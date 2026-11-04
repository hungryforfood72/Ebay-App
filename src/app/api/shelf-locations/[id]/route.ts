import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Owner only (Settings). Refused while bins are on the shelf, or while it's
// oversized or a Whatnot shelf: deleting and re-adding it would quietly
// reset those, leaving its bins on a shelf that no longer says what it is.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const shelf = await prisma.shelfLocation.findUnique({ where: { id } });
  if (!shelf) return NextResponse.json({ ok: true });
  if (shelf.oversized || shelf.whatnot) {
    return NextResponse.json(
      { error: `Shelf ${shelf.label} is ${shelf.oversized ? "oversized" : "a Whatnot shelf"}. Make it a regular bin shelf on the Bins page first.` },
      { status: 409 }
    );
  }
  const bins = await prisma.bin.count({ where: { shelfLabel: shelf.label } });
  if (bins > 0) {
    return NextResponse.json(
      { error: `Shelf ${shelf.label} has ${bins} ${bins === 1 ? "bin" : "bins"} on it. Move ${bins === 1 ? "it" : "them"} off first.` },
      { status: 409 }
    );
  }
  await prisma.shelfLocation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
