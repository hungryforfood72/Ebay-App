import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { naturalSort } from "@/lib/naturalSort";
import { backfillBoxCodes, saveBoxSize, toBoxSizeDto } from "@/lib/warehouse/boxSizes";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Box sizes for the scan and review pages' Box Size dropdown, and (in
// warehouse mode) the box barcodes scanned at the listing station. Returns
// BoxSizeDto[] (src/lib/warehouse/boxSizes.ts): id, label, code, tareOz,
// lengthIn/widthIn/heightIn as numbers or null.
export async function GET() {
  await backfillBoxCodes();
  const sizes = await prisma.boxSize.findMany();
  return NextResponse.json(naturalSort(sizes, (s) => s.label).map(toBoxSizeDto));
}

// Owner only (Settings). Body: { label, code?, tareOz?, lengthIn?,
// widthIn?, heightIn? }. A blank code gets the next BXnnn.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await saveBoxSize(null, body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
