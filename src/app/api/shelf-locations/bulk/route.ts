import { prisma } from "@/lib/prisma";
import { parseLocationRange } from "@/lib/locationRange";
import { NextRequest, NextResponse } from "next/server";

// Expands a range like "A1-A50" and creates every location in one request,
// instead of adding 50 one at a time through the regular POST.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const range = String(body.range ?? "").trim();
  if (!range) {
    return NextResponse.json({ error: "range is required" }, { status: 400 });
  }

  let labels: string[];
  try {
    labels = parseLocationRange(range);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid range." },
      { status: 400 }
    );
  }
  if (labels.length === 0) {
    return NextResponse.json({ error: "No locations to add." }, { status: 400 });
  }

  const result = await prisma.shelfLocation.createMany({
    data: labels.map((label) => ({ label })),
    skipDuplicates: true,
  });

  return NextResponse.json(
    { ok: true, added: result.count, requested: labels.length },
    { status: 201 }
  );
}
