import { forViewer } from "@/lib/itemView";
import { prisma } from "@/lib/prisma";
import { ALREADY_PUBLISHING, claimPublish, releasePublish } from "@/lib/publishLock";
import { binGateError } from "@/lib/warehouse/binGate";
import { whatnotConfigured } from "@/lib/whatnot";
import { publishWhatnotOnlyItem } from "@/lib/whatnotSync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// The review page's Publish button for a Whatnot-only item (Cristian,
// 2026-11-06): an auction at its start price through Whatnot's own API,
// put in its Whatnot bin's show if the bin has one (whatnotSync.ts). Same
// explicit "make it live" step and bar as the other publish routes.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!whatnotConfigured()) {
    return NextResponse.json({ error: "Whatnot isn't connected yet (the API token goes in Vercel)." }, { status: 400 });
  }
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });
  if (!item.whatnotOnly) {
    return NextResponse.json({ error: "This item isn't a Whatnot listing." }, { status: 400 });
  }
  if (item.status !== "ready") {
    return NextResponse.json({ error: "Mark it ready in review first." }, { status: 400 });
  }
  if (!item.whatnotPublishedAt) {
    const binError = await binGateError(item);
    if (binError) return NextResponse.json({ error: binError }, { status: 400 });
  }
  const missing: string[] = [];
  if (!item.finalTitle) missing.push("title");
  if (item.price == null) missing.push("starting price");
  if (!item.categoryId) missing.push("category");
  if (!item.weightLbs && !item.weightOz) missing.push("weight (Whatnot works out the buyer's shipping from it)");
  if (item.photoUrls.length === 0) missing.push("at least one photo");
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing ${missing.join(", ")} before this can be published.` }, { status: 400 });
  }

  if (!(await claimPublish(id))) return NextResponse.json({ error: ALREADY_PUBLISHING }, { status: 409 });
  try {
    await publishWhatnotOnlyItem(id);
    return NextResponse.json(forViewer(request, await prisma.item.findUnique({ where: { id } })));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Publish failed." }, { status: 502 });
  } finally {
    await releasePublish(id);
  }
}
