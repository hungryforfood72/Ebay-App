import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const sizes = await prisma.boxSize.findMany({ orderBy: { label: "asc" } });
  return NextResponse.json(sizes);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const label = String(body.label ?? "").trim();
  if (!label) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }

  const size = await prisma.boxSize.upsert({
    where: { label },
    create: { label },
    update: {},
  });
  return NextResponse.json(size, { status: 201 });
}
