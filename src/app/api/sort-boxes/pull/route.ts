import { getRequestUser, requireUser } from "@/lib/auth";
import { pullForListing } from "@/lib/warehouse/sortBoxes";
import { productNameOnLoad } from "@/lib/warehouse/sortCount";
import { nameExtraForListing } from "@/lib/warehouse/sortStation";
import { errorResponse } from "@/lib/warehouse/stations";
import { after, NextRequest, NextResponse } from "next/server";

// Room for naming an extra after responding (see POST).
export const maxDuration = 60;

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
  if (manifestId.length > 64 || upc.length > 64) return NextResponse.json({ error: "That isn't a product barcode." }, { status: 400 });
  try {
    requireUser(request);
    const result = await pullForListing({ manifestId, upc, by: getRequestUser(request)?.username ?? null });
    // Nobody gathered it first: an extra the sorter couldn't name gets
    // named now, while the lister fills in the rest, so its label prints
    // the name (Cristian, 2026-11-03). Already named = one quick read. Only
    // on the scan that pulled it, so each single listed after doesn't pay
    // for another search when no name was found.
    if (result.pulled.some((p) => p.units > 0)) after(() => nameExtraForListing(manifestId, upc));
    // What the load calls this barcode, shown big so a wrong scan is seen.
    const name = await productNameOnLoad(manifestId, upc).catch(() => null);
    return NextResponse.json({ ...result, name });
  } catch (e) {
    return errorResponse(e);
  }
}
