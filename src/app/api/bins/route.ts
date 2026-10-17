import { ownerOnly } from "@/lib/auth";
import { applyPendingRemovals, createBins } from "@/lib/warehouse/bins";
import { getShelfStates } from "@/lib/warehouse/shelves";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, summarizeBins } from "./shared";

// Every bin with its status and counts, plus the shelf labels (for the
// "by shelf" filter and shelf label printing). Bin counts stay in the low
// thousands, so the Bins page filters on its own instead of paging.
//
// Also settles any bin removals still pending from a sale or pull that
// couldn't update the bins at the time (see removeUnitsBestEffort);
// pendingRemovals is how many are still owed after trying.
export async function GET() {
  const pendingRemovals = await applyPendingRemovals();
  const [bins, shelfStates] = await Promise.all([summarizeBins(), getShelfStates()]);
  return NextResponse.json({
    pendingRemovals,
    bins,
    shelves: shelfStates.map((s) => s.label),
    // Which shelves take bins yet (warehouse cutover, see shelves.ts).
    shelfStates,
  });
}

// Makes new bins: { count } -> { codes }. Owner only, so nobody makes a
// pile of bin numbers by accident.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  try {
    const codes = await createBins(Number(body.count));
    return NextResponse.json({ codes }, { status: 201 });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
