import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const locations = await prisma.shelfLocation.findMany({ orderBy: { label: "asc" } });
  return NextResponse.json(locations);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const label = String(body.label ?? "").trim();
  if (!label) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }

  const location = await prisma.shelfLocation.upsert({
    where: { label },
    create: { label },
    update: {},
  });
  return NextResponse.json(location, { status: 201 });
}
