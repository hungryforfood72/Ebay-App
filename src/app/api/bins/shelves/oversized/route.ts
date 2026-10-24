import { logActivity } from "@/lib/activityLog";
import { getRequestUser, requireOwner } from "@/lib/auth";
import { setShelfOversized } from "@/lib/warehouse/shelves";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, readCode } from "../../shared";

// Owner only: { shelfLabel, on } makes a shelf oversized (items straight
// on it, no bins) or a bin shelf again. See setShelfOversized for when
// that's refused. -> { shelf }.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const shelfLabel = readCode(body.shelfLabel);
  if (!shelfLabel) return NextResponse.json({ error: "Which shelf?" }, { status: 400 });
  if (typeof body.on !== "boolean") return NextResponse.json({ error: "Send on: true or false." }, { status: 400 });
  try {
    requireOwner(request);
    const shelf = await setShelfOversized(shelfLabel, body.on, getRequestUser(request)?.username ?? null);
    await logActivity(
      { request },
      {
        action: "setting",
        summary: `Shelf ${shelf.label}: ${body.on ? "oversized (no bins)" : "bin shelf again"}`,
        targetType: "shelf",
        targetId: shelf.label,
        after: { oversized: body.on },
      }
    );
    return NextResponse.json({ shelf });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
