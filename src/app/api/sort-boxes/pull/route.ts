import { getRequestUser } from "@/lib/auth";
import { WarehouseError } from "@/lib/warehouse/bins";
import { pullForListing } from "@/lib/warehouse/sortBoxes";
import { NextRequest, NextResponse } from "next/server";

// POST { manifestId, upc }: the List page just scanned this product, so
// every unit of it still in a sort box counts as pulled to the listing
// table (Cristian: no scanning box by box). Returns { pulled: [{ boxCode,
// units }], locations: [{ boxCode, inBox, pulled, sorted }] }: what to go
// grab, and the whole picture. Scanning it again pulls nothing new.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const manifestId = typeof body.manifestId === "string" ? body.manifestId : "";
  const upc = typeof body.upc === "string" ? body.upc.trim() : "";
  if (!manifestId || !upc) return NextResponse.json({ error: "A manifest and a UPC are required." }, { status: 400 });
  try {
    return NextResponse.json(await pullForListing({ manifestId, upc, by: getRequestUser(request)?.username ?? null }));
  } catch (e) {
    if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
