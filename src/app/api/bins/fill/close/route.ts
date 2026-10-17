import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findBin } from "@/lib/warehouse/bins";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, readCode, summarizeBins } from "../../shared";

// Binning station "Close bin": done filling, ready to shelve.
// { binCode } -> { bin }. An empty bin has nothing to close and is left
// as it is (still reusable).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const binCode = readCode(body.binCode);
  if (!binCode) return NextResponse.json({ error: "Scan a bin." }, { status: 400 });
  try {
    const bin = await findBin(prisma, binCode);
    const items = await prisma.binContent.count({ where: { binId: bin.id } });
    if (items > 0) {
      await prisma.bin.update({
        where: { id: bin.id },
        data: { closedAt: new Date(), closedBy: getRequestUser(request)?.username ?? null },
      });
    }
    const [summary] = await summarizeBins({ id: bin.id });
    return NextResponse.json({ bin: summary });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
