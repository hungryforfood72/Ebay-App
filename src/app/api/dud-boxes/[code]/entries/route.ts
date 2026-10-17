import { requireUser } from "@/lib/auth";
import { addDudEntry } from "@/lib/warehouse/dudBoxReview";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// The sort station putting duds in the box: { manifestId, upc, quantity,
// note? }. Same tally as POST /api/manifests/{id}/duds (it counts as dud on
// the manifest), plus which box the units went into. Refused unless the box
// is open and belongs to that load.
export async function POST(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  try {
    const user = requireUser(request);
    const { code } = await params;
    const body = await request.json().catch(() => ({}));
    const result = await addDudEntry({
      code,
      manifestId: typeof body.manifestId === "string" ? body.manifestId : "",
      upc: String(body.upc ?? "").trim(),
      quantity: Number(body.quantity),
      note: typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null,
      by: user.username,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
