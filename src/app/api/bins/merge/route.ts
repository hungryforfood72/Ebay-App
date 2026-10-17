import { getRequestUser } from "@/lib/auth";
import { moveBinContents } from "@/lib/warehouse/bins";
import { normalizeCode } from "@/lib/warehouse/codes";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, readCode, summarizeBins } from "../shared";

// Empties one bin into another: { fromBinCode, toBinCode } ->
// { itemsMoved, unitsMoved, fromEmpty, from, to }. The counts are what
// actually moved when it saved, which can be less than the preview showed
// if someone picked from the bin in between, so the page shows these.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const fromBinCode = readCode(body.fromBinCode);
  const toBinCode = readCode(body.toBinCode);
  if (!fromBinCode || !toBinCode) {
    return NextResponse.json({ error: "Scan the bin to empty and the bin to move into." }, { status: 400 });
  }
  try {
    const result = await moveBinContents({
      fromBinCode,
      toBinCode,
      by: getRequestUser(request)?.username ?? null,
      unshelveEmptiedFrom: true,
    });
    const bins = await summarizeBins({ code: { in: [normalizeCode(fromBinCode), normalizeCode(toBinCode)] } });
    return NextResponse.json({
      ...result,
      from: bins.find((b) => b.code === normalizeCode(fromBinCode)) ?? null,
      to: bins.find((b) => b.code === normalizeCode(toBinCode)) ?? null,
    });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
