import { requireUser } from "@/lib/auth";
import { logReturn } from "@/lib/warehouse/consignmentSort";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Consignment loads only: "Set aside for the supplier" at the sort station.
// { manifestId, code, quantity } -> 201 { id, upc, quantity }. Undo through
// /api/sort/undo with kind "return".
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    const entry = await logReturn({
      manifestId: String(body.manifestId ?? ""),
      code: String(body.code ?? ""),
      quantity: Number(body.quantity),
      by: user.username,
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
