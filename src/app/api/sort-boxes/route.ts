import { ownerOnly, requireUser } from "@/lib/auth";
import { errorResponse } from "@/lib/warehouse/stations";
import { createSortBoxes } from "@/lib/warehouse/sortBoxes";
import { listSortBoxes } from "@/lib/warehouse/sortStation";
import { NextRequest, NextResponse } from "next/server";

// Sort boxes (SB0001...): GET lists every box with its current load and the
// units still in it (free when 0). No money, so anyone signed in.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    return NextResponse.json({ boxes: await listSortBoxes() });
  } catch (e) {
    return errorResponse(e);
  }
}

// Make new boxes: { count } -> 201 { codes }. Owner only, so nobody makes a
// pile of box numbers by accident (same as bins).
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ codes: await createSortBoxes(Number(body.count)) }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
