import { AuthError, requireUser } from "@/lib/auth";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getItemLocations } from "@/lib/warehouse/bins";
import { NextRequest, NextResponse } from "next/server";

// What staff still need to pull off shelves / out of bins: listings that
// came off eBay for their date, or because the package says Rx Only
// (pullReason "rx_return"). Same list as the Dashboard's, small enough for
// the List page to check on the scanner (Cristian, 2026-10-25). Any
// signed-in user; no money in it. GET -> { items: [...] }.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const items = await prisma.item.findMany({
    where: { status: "expired", shelfPullAcknowledgedAt: null, expirySplit: { equals: Prisma.AnyNull } },
    orderBy: { expiredAt: "asc" },
    select: { id: true, finalTitle: true, sku: true, shelfLocation: true, pullReason: true },
  });
  const locations = await getItemLocations(items);
  return NextResponse.json({ items: items.map((i) => ({ ...i, location: locations.get(i.id) ?? null })) });
}
