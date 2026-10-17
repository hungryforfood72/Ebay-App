import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findBin, shelveBin } from "@/lib/warehouse/bins";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, readCode, summarizeBins } from "../shared";

// Takes a bin off its shelf: { binCode } -> { bin, previousShelf }. For a
// bin brought back to a station, or an empty one grabbed for reuse.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const binCode = readCode(body.binCode);
  if (!binCode) return NextResponse.json({ error: "Scan a bin first." }, { status: 400 });
  try {
    const bin = await findBin(prisma, binCode);
    await shelveBin({ binCode: bin.code, shelfLabel: null, by: getRequestUser(request)?.username ?? null });
    const [summary] = await summarizeBins({ id: bin.id });
    return NextResponse.json({ bin: summary, previousShelf: bin.shelfLabel });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
