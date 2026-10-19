import { WarehouseError } from "@/lib/warehouse/bins";
import { putBack } from "@/lib/warehouse/sortBoxes";
import { NextRequest, NextResponse } from "next/server";

// POST { manifestId, upc, boxCode, units }: "Left some here". Units of this
// product the List page counted as pulled are still in that sort box, so
// they go back on its count. Returns { locations }.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const manifestId = typeof body.manifestId === "string" ? body.manifestId : "";
  const upc = typeof body.upc === "string" ? body.upc.trim() : "";
  const boxCode = typeof body.boxCode === "string" ? body.boxCode : "";
  if (!manifestId || !upc || !boxCode) {
    return NextResponse.json({ error: "A manifest, a UPC and a box are required." }, { status: 400 });
  }
  try {
    return NextResponse.json(await putBack({ manifestId, upc, boxCode, units: Number(body.units) }));
  } catch (e) {
    if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
