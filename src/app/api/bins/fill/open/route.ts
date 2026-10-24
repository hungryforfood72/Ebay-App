import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, getBinDetail, readCode } from "../../shared";
import { resolveBinScan } from "@/lib/warehouse/shelves";
import { openForFilling } from "../shared";

// Binning station: open a bin to fill. { binCode } ->
// { ...BinDetail, wasClosed }. wasClosed = it had been closed and is now
// reopened ("adding anyway"). Re-opening a partly filled open bin after a
// break is normal and just returns what's in it. An oversized shelf's
// label opens that shelf (its hidden bin): items go straight on it.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const binCode = readCode(body.binCode);
  if (!binCode) return NextResponse.json({ error: "Scan a bin." }, { status: 400 });
  try {
    const code = await resolveBinScan(prisma, binCode);
    const { bin, wasClosed } = await prisma.$transaction((tx) => openForFilling(tx, code));
    return NextResponse.json({ ...(await getBinDetail(bin.code)), wasClosed });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
