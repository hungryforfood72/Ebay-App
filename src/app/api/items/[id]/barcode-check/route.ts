import { requireUser } from "@/lib/auth";
import { barcodeMismatchBlocks } from "@/lib/barcodeMismatch";
import { prisma } from "@/lib/prisma";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// GET: the List page checking the item it just saved, once its draft is
// written (a few seconds to a minute after the save): { drafted, mismatch }.
// mismatch = the draft's note when the photos show a different product than
// the barcode, so the lister hears about it while the item is still in
// hand. No money in it; any signed-in user.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireUser(request);
    const { id } = await params;
    const item = await prisma.item.findUnique({ where: { id }, select: { sku: true, aiTitle: true, barcodeMismatch: true } });
    if (!item) return NextResponse.json({ error: "That item doesn't exist anymore." }, { status: 404 });
    return NextResponse.json({
      code: item.sku,
      drafted: item.aiTitle != null,
      mismatch: barcodeMismatchBlocks(item.barcodeMismatch) ? item.barcodeMismatch : null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
