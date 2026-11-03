import { getRequestUser, requireUser } from "@/lib/auth";
import { WarehouseError } from "@/lib/warehouse/bins";
import { fixBoxCount } from "@/lib/warehouse/sortBoxes";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// POST { manifestId, upc, boxCode, found, page }: "Count was off". The box
// really held `found` of this product, not what the sort said. Fixes the
// box's count and records it (SortCountFix). Returns { locations, delta }.
export async function POST(request: NextRequest) {
  try {
    requireUser(request);
    const body = await request.json().catch(() => ({}));
    const manifestId = typeof body.manifestId === "string" ? body.manifestId : "";
    const upc = typeof body.upc === "string" ? body.upc.trim() : "";
    const boxCode = typeof body.boxCode === "string" ? body.boxCode : "";
    if (!manifestId || !upc || !boxCode) throw new WarehouseError("A load, a product and a box are required.");
    return NextResponse.json(
      await fixBoxCount({
        manifestId,
        upc,
        boxCode,
        found: Number(body.found),
        by: getRequestUser(request)?.username ?? null,
        page: body.page === "list" ? "list" : "gather",
      })
    );
  } catch (e) {
    return errorResponse(e);
  }
}
