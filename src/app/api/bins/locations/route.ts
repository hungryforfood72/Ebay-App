import { prisma } from "@/lib/prisma";
import { getItemLocations } from "@/lib/warehouse/bins";
import type { ItemLocation } from "@/lib/warehouse/types";
import { NextRequest, NextResponse } from "next/server";

// Where each of these items is: { itemIds } -> { locations: { [id]: ItemLocation } }.
// For pages whose item list comes from a route that doesn't include
// locations (the Review page's GET /api/items). POST so a long list of ids
// doesn't blow past URL limits.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.itemIds)
    ? [...new Set<string>(body.itemIds.filter((v: unknown): v is string => typeof v === "string"))].slice(0, 1000)
    : [];
  if (ids.length === 0) return NextResponse.json({ locations: {} });
  const items = await prisma.item.findMany({ where: { id: { in: ids } }, select: { id: true, shelfLocation: true } });
  const map = await getItemLocations(items);
  const locations: Record<string, ItemLocation> = Object.fromEntries(map);
  return NextResponse.json({ locations });
}
