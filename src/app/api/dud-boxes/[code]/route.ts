import { getRequestUser, requireUser } from "@/lib/auth";
import { getDudBoxDetail, setDudBoxStatus } from "@/lib/warehouse/dudBoxReview";
import { WarehouseError } from "@/lib/warehouse/bins";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// One dud box and what's in it: { box: { code, status, manifestId,
// manifestTitle, ... }, entries: [{ id, upc, description, quantity,
// listedUnits, decision, decidedBy, decidedAt, dudReason, ... }] } (see
// DudBoxDetail). The scan page's "list from a dud box" reads this too, so
// keep those fields. The owner also gets each entry's Analyzer money hint;
// employees never see money.
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  try {
    requireUser(request);
    const { code } = await params;
    const isOwner = getRequestUser(request)?.role === "owner";
    return NextResponse.json(await getDudBoxDetail(code, isOwner));
  } catch (e) {
    return errorResponse(e);
  }
}

// { status: "closed" } when the box is full, { status: "open" } to reopen
// it. "done" happens on its own once everything in it is handled.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  try {
    requireUser(request);
    const { code } = await params;
    const body = await request.json().catch(() => ({}));
    if (body.status !== "open" && body.status !== "closed") {
      throw new WarehouseError(
        'status must be "open" or "closed". A box is done on its own once everything is handled.'
      );
    }
    return NextResponse.json(await setDudBoxStatus(code, body.status));
  } catch (e) {
    return errorResponse(e);
  }
}
