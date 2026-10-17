import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { takeFromBin } from "@/lib/warehouse/bins";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, getBinDetail, readCode } from "../../shared";

// Binning station "Undo last scan": takes that one unit back out of that
// bin, never another one (logged as an adjust with a note, next to the
// place it reverses). { binCode, itemId } -> BinDetail.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const binCode = readCode(body.binCode);
  const itemId = readCode(body.itemId);
  if (!binCode || !itemId) return NextResponse.json({ error: "Nothing to undo." }, { status: 400 });
  try {
    await prisma.$transaction((tx) =>
      takeFromBin(tx, { itemId, binCode, units: 1, by: getRequestUser(request)?.username ?? null, note: "Undo scan" })
    );
    return NextResponse.json(await getBinDetail(binCode));
  } catch (e) {
    return binsErrorResponse(e);
  }
}
