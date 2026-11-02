import { getRequestUser, requireUser } from "@/lib/auth";
import { packSuggestion } from "@/lib/packSuggestion";
import { prisma } from "@/lib/prisma";
import { lineKey } from "@/lib/upcMatch";
import { WarehouseError } from "@/lib/warehouse/bins";
import { boxesLeft, loadsToGather, pullForListing } from "@/lib/warehouse/sortBoxes";
import { matchLineCode } from "@/lib/warehouse/sortCheck";
import { errorResponse } from "@/lib/warehouse/stations";
import { after, NextRequest, NextResponse } from "next/server";

// Room for the pack card's research, started after responding (see POST).
export const maxDuration = 120;

// The lister's helper (/gather, Cristian 2026-11-01): pulls every unit of
// a product out of the sort boxes ahead of the lister, so the lister finds
// it all on the table instead of walking the boxes.
//
// GET -> { loads }: loads with units still in sort boxes.
// GET ?manifestId= -> { title, boxes }: that load's boxes still holding units.
// POST { manifestId, code } (a scan, or a search result's key) ->
//   { product, pulled, locations, boxes }: same pull as the List page
//   (pullForListing), so the lister's scan later pulls nothing new and
//   says it's already gathered.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    const manifestId = request.nextUrl.searchParams.get("manifestId");
    if (!manifestId) return NextResponse.json({ loads: await loadsToGather() });
    const manifest = await prisma.manifest.findUnique({ where: { id: manifestId }, select: { title: true } });
    if (!manifest) throw new WarehouseError("That load doesn't exist anymore.", 404);
    return NextResponse.json({ title: manifest.title, boxes: await boxesLeft(manifestId) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    requireUser(request);
    const body = await request.json().catch(() => ({}));
    const manifestId = typeof body.manifestId === "string" ? body.manifestId : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!manifestId || !code) throw new WarehouseError("Pick the load and scan a product.");

    const lines = await prisma.manifestLine.findMany({
      where: { manifestId },
      select: { id: true, upc: true, supplierSku: true, description: true },
      orderBy: { sortOrder: "asc" },
    });
    // Sorted units are stored under the manifest line's key; an extra (not
    // on the manifest) under the code that was scanned.
    const key = matchLineCode(lines, code) ?? code;
    const line = lines.find((l) => lineKey(l) === key);

    const result = await pullForListing({ manifestId, upc: key, by: getRequestUser(request)?.username ?? null });
    // Start the pack card's online research now (most of a minute), so it's
    // saved and shows right away when the lister scans this product
    // (Cristian, 2026-11-02). Same count the lister will see.
    after(() =>
      packSuggestion({ upc: key, manifestId, isOwner: false }).catch((e) =>
        console.error(`[gather] pack research for ${key} failed`, e)
      )
    );
    return NextResponse.json({
      product: { key, description: line?.description ?? null },
      ...result,
      boxes: await boxesLeft(manifestId),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
