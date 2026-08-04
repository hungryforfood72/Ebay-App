import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// List open (not yet ended) scan sessions, most recent first.
export async function GET() {
  const sessions = await prisma.scanSession.findMany({
    where: { endedAt: null },
    orderBy: { startedAt: "desc" },
    include: { _count: { select: { items: true } } },
  });

  return NextResponse.json(sessions);
}

// Start a new scan session.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));

  const session = await prisma.scanSession.create({
    data: {
      startedBy: body.startedBy ?? null,
      label: body.label ?? null,
    },
  });

  return NextResponse.json(session, { status: 201 });
}
