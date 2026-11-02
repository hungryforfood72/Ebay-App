import { getRequestUser } from "@/lib/auth";
import { packSuggestion } from "@/lib/packSuggestion";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// The pack call searches online (most of a minute), next to the store-price
// check, unless the gather helper already started it.
export const maxDuration = 120;

// GET ?upc=&manifestId= — see packSuggestion (src/lib/packSuggestion.ts).
export async function GET(request: NextRequest) {
  const isOwner = getRequestUser(request)?.role === "owner";
  const upc = request.nextUrl.searchParams.get("upc")?.trim();
  const manifestId = request.nextUrl.searchParams.get("manifestId");
  if (!upc) return NextResponse.json({ error: "A UPC is required." }, { status: 400 });
  return NextResponse.json(await packSuggestion({ upc, manifestId, isOwner }));
}

// POST { upc, manifestId, count } — saves the count Lizvet typed on the
// pack card; count null clears it, back to the manifest's count.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { upc?: string; manifestId?: string | null; count?: number | null } | null;
  const upc = body?.upc?.trim();
  if (!upc) return NextResponse.json({ error: "A UPC is required." }, { status: 400 });
  const manifestId = body?.manifestId || null;
  const count = Number(body?.count);
  if (body?.count != null && (!Number.isInteger(count) || count < 1 || count > 1000)) {
    return NextResponse.json({ error: "Enter a whole number from 1 to 1000." }, { status: 400 });
  }
  await prisma.handCount.deleteMany({ where: { upc, manifestId } });
  if (body?.count != null) await prisma.handCount.create({ data: { upc, manifestId, count } });
  return NextResponse.json({ ok: true });
}
