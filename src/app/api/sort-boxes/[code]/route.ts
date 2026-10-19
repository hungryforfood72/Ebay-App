import { requireUser } from "@/lib/auth";
import { errorResponse } from "@/lib/warehouse/stations";
import { getSortBoxSummary } from "@/lib/warehouse/sortStation";
import { NextRequest, NextResponse } from "next/server";

// One sort box: { code, manifestId, manifestTitle, unitsLeft, unitsSorted,
// free, assignedAt }. The sort page re-checks its remembered box with this.
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  try {
    requireUser(request);
    const { code } = await params;
    return NextResponse.json(await getSortBoxSummary(code));
  } catch (e) {
    return errorResponse(e);
  }
}
