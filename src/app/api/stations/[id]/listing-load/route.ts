import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { relistStation } from "@/lib/warehouse/cancelledOrders";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// The load being listed at this station, for the station PC's Dud boxes
// card: the load of the newest item label printed here (the listing page
// picks the load on the handheld, so the station only knows it from what
// it printed). { listingStation, manifestId, manifestTitle }. Only the
// Listing Station has dud boxes (Cristian, 2026-11-06), the same station
// relisting uses (relistStation); any other station gets listingStation
// false and the card stays hidden.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireUser(request);
    const { id } = await params;
    const listing = await relistStation();
    if (listing?.id !== id) {
      return NextResponse.json({ listingStation: false, manifestId: null, manifestTitle: null });
    }
    const jobs = await prisma.printJob.findMany({
      where: { stationId: id, kind: "item" },
      orderBy: { seq: "desc" },
      take: 20,
      select: { payload: true },
    });
    const codes = jobs
      .map((j) => (j.payload as { code?: unknown } | null)?.code)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
    if (codes.length > 0) {
      const items = await prisma.item.findMany({
        where: { sku: { in: codes }, manifestId: { not: null } },
        select: { sku: true, manifest: { select: { id: true, title: true, purchased: true } } },
      });
      const bySku = new Map(items.map((i) => [i.sku, i.manifest]));
      for (const code of codes) {
        const m = bySku.get(code);
        if (m?.purchased) return NextResponse.json({ listingStation: true, manifestId: m.id, manifestTitle: m.title });
      }
    }
    return NextResponse.json({ listingStation: true, manifestId: null, manifestTitle: null });
  } catch (e) {
    return errorResponse(e);
  }
}
