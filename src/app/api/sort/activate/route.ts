import { requireUser } from "@/lib/auth";
import { errorResponse } from "@/lib/warehouse/stations";
import { activateSortBox } from "@/lib/warehouse/sortBoxes";
import { getSortBoxSummary } from "@/lib/warehouse/sortStation";
import { NextRequest, NextResponse } from "next/server";

// The sorter scanned a sort box label: { boxCode, manifestId } makes it this
// load's box (an empty one is tied to the load; one still holding another
// load's units is refused with a 409 naming that load).
// -> { box: SortBoxSummary, reassigned }
export async function POST(request: NextRequest) {
  try {
    requireUser(request);
    const body = await request.json().catch(() => ({}));
    const result = await activateSortBox({
      boxCode: String(body.boxCode ?? ""),
      manifestId: String(body.manifestId ?? ""),
    });
    return NextResponse.json({ box: await getSortBoxSummary(result.boxCode), reassigned: result.reassigned });
  } catch (e) {
    return errorResponse(e);
  }
}
