import { prisma } from "@/lib/prisma";
import { toBoxSizeDto } from "@/lib/warehouse/boxSizes";
import { normalizeCode } from "@/lib/warehouse/codes";
import { NextRequest, NextResponse } from "next/server";

// The box whose barcode (BX001) was just scanned at the listing station.
// Returns one BoxSizeDto, or 404 with a message to show the lister.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = normalizeCode(raw);
  const box = await prisma.boxSize.findFirst({ where: { code } });
  if (!box) {
    return NextResponse.json(
      { error: `No box with code ${code}. Check the label, or add the box in Settings.` },
      { status: 404 }
    );
  }
  return NextResponse.json(toBoxSizeDto(box));
}
