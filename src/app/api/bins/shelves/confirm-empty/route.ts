import { getRequestUser, requireOwner, requireUser } from "@/lib/auth";
import { confirmShelfEmpty, undoShelfConfirm } from "@/lib/warehouse/shelves";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, readCode } from "../../shared";

// "I looked, this shelf really is empty of old-system items": lets bins go
// on it. Anyone signed in can confirm (whoever is standing at the shelf);
// it records who. Only from "looks empty": refused while the records still
// show old items there. { shelfLabel } -> { shelf }.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const shelfLabel = readCode(body.shelfLabel);
  if (!shelfLabel) return NextResponse.json({ error: "Which shelf?" }, { status: 400 });
  try {
    requireUser(request);
    return NextResponse.json({ shelf: await confirmShelfEmpty(shelfLabel, getRequestUser(request)?.username ?? null) });
  } catch (e) {
    return binsErrorResponse(e);
  }
}

// Owner only: undo a confirm made by mistake. Refused once bins are on the
// shelf. { shelfLabel } (or ?shelfLabel=) -> { shelf }.
export async function DELETE(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const shelfLabel = readCode(body.shelfLabel) || (request.nextUrl.searchParams.get("shelfLabel")?.trim() ?? "");
  if (!shelfLabel) return NextResponse.json({ error: "Which shelf?" }, { status: 400 });
  try {
    requireOwner(request);
    return NextResponse.json({ shelf: await undoShelfConfirm(shelfLabel) });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
