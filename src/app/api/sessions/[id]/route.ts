import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// Mark a scan session as finished. Items already saved to it are unaffected,
// this just stops it from showing up as "resume" on the scan screen.
export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await prisma.scanSession.update({
    where: { id },
    data: { endedAt: new Date() },
  });

  return NextResponse.json(session);
}
