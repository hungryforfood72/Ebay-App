import { requireUser } from "@/lib/auth";
import { WarehouseError } from "@/lib/warehouse/bins";
import { errorResponse } from "@/lib/warehouse/stations";
import { setSortingDone } from "@/lib/warehouse/sortStation";
import { NextRequest, NextResponse } from "next/server";

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
