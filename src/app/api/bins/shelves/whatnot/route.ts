import { logActivity } from "@/lib/activityLog";
import { requireOwner } from "@/lib/auth";
import { setShelfWhatnot } from "@/lib/warehouse/shelves";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, readCode } from "../../shared";

// Owner only: { shelfLabel, on } makes a shelf a Whatnot shelf (only
// Whatnot bins on it) or a regular shelf again. Refused while anything is
// on it, see setShelfWhatnot. -> { shelf }.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const shelfLabel = readCode(body.shelfLabel);
  if (!shelfLabel) return NextResponse.json({ error: "Which shelf?" }, { status: 400 });
  if (typeof body.on !== "boolean") return NextResponse.json({ error: "Send on: true or false." }, { status: 400 });
  try {
    requireOwner(request);
    const shelf = await setShelfWhatnot(shelfLabel, body.on);
    await logActivity(
      { request },
      {
        action: "setting",
        summary: `Shelf ${shelf.label}: ${body.on ? "Whatnot shelf" : "regular shelf again"}`,
        targetType: "shelf",
        targetId: shelf.label,
        after: { whatnot: body.on },
      }
    );
    return NextResponse.json({ shelf });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
