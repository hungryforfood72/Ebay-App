import { sortLocations } from "@/lib/warehouse/sortBoxes";
import { NextRequest, NextResponse } from "next/server";

// GET ?manifestId=&upc=: which sort boxes hold this product on this load,
// without pulling anything: [{ boxCode, inBox, pulled, sorted }]. Empty =
// nothing sorted for it.
export async function GET(request: NextRequest) {
  const manifestId = request.nextUrl.searchParams.get("manifestId") ?? "";
  const upc = request.nextUrl.searchParams.get("upc")?.trim() ?? "";
  if (!manifestId || !upc) return NextResponse.json({ error: "A manifest and a UPC are required." }, { status: 400 });
  return NextResponse.json({ locations: await sortLocations(manifestId, upc) });
}
