import { prisma } from "@/lib/prisma";
import { naturalSort } from "@/lib/naturalSort";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  // Postgres ORDER BY on the label column is lexicographic (A1, A10, A2,
  // ...) — sort naturally instead so A1..A50 comes out in the order
  // shelves are actually numbered.
  const locations = await prisma.shelfLocation.findMany();
  return NextResponse.json(naturalSort(locations, (l) => l.label));
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
