import { requireUser } from "@/lib/auth";
import { WarehouseError } from "@/lib/warehouse/bins";
import { errorResponse } from "@/lib/warehouse/stations";
import { recentSorters, setSortingDone } from "@/lib/warehouse/sortStation";
import { NextRequest, NextResponse } from "next/server";

// Minutes back that count as "still sorting" in the done popup.
const RECENT_MINUTES = 30;

// Before "Sorting done": GET ?manifestId= -> { others: [{ username, lastAt }],
// minutes }, everyone else who logged on this load in the last 30 minutes,
// so the popup can name who might still be sorting.
export async function GET(request: NextRequest) {
  try {
    const user = requireUser(request);
    const manifestId = request.nextUrl.searchParams.get("manifestId") ?? "";
    if (!manifestId) throw new WarehouseError("Pick the load first.");
    const others = await recentSorters({ manifestId, exclude: user.username, minutes: RECENT_MINUTES });
    return NextResponse.json({ others, minutes: RECENT_MINUTES });
  } catch (e) {
    return errorResponse(e);
  }
}

// "Sorting done" for a load: { manifestId } sets Manifest.sortedAt/sortedBy
// (anyone signed in). { manifestId, undo: true } clears it, owner only, so a
// finished count can't be reopened by accident from a handheld.
// -> { sortedAt, sortedBy }
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    if (typeof body.manifestId !== "string" || !body.manifestId) throw new WarehouseError("Pick the load first.");
    if (body.undo === true && user.role !== "owner") {
      throw new WarehouseError("Only the owner can reopen a finished sort.", 403);
    }
    return NextResponse.json(
      await setSortingDone({ manifestId: body.manifestId, done: body.undo !== true, by: user.username })
    );
  } catch (e) {
    return errorResponse(e);
  }
}
