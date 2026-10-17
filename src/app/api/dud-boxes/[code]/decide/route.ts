import { requireUser } from "@/lib/auth";
import { WarehouseError } from "@/lib/warehouse/bins";
import { decideDudEntries } from "@/lib/warehouse/dudBoxReview";
import { isDudDecision } from "@/lib/warehouse/dudBoxTypes";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Decide what happens to a product in the box:
// { entryId, decision: "shopify" | "not_worth" | "toss" | "donate" | null }.
// entryIds: [...] in place of entryId decides several at once (the /duds
// page does that when the sorter logged the same product more than once).
// Anyone signed in can decide; it records who and when. Once every product
// is decided and the Shopify ones are all listed, a closed box turns done.
export async function POST(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  try {
    const user = requireUser(request);
    const { code } = await params;
    const body = await request.json().catch(() => ({}));
    const entryIds: string[] = Array.isArray(body.entryIds)
      ? body.entryIds.filter((id: unknown): id is string => typeof id === "string")
      : typeof body.entryId === "string"
        ? [body.entryId]
        : [];
    if (body.decision !== null && !isDudDecision(body.decision)) {
      throw new WarehouseError('decision must be "shopify", "not_worth", "toss", "donate" or null.');
    }
    return NextResponse.json(await decideDudEntries({ code, entryIds, decision: body.decision, by: user.username }));
  } catch (e) {
    return errorResponse(e);
  }
}
