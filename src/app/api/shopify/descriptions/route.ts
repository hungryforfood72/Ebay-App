import { AuthError, requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { refreshShopifyDescription } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 120;

// Owner only: re-sends live items' descriptions to their Shopify products, a
// batch at a time (Cristian, 2026-10-25: every live listing moved to the
// sectioned layout, but the Shopify keys only live on the server).
// POST { afterId?, limit? } -> { done, failed: [{ sku, error }], nextAfterId }.
// nextAfterId null = that was the last batch.
export async function POST(request: NextRequest) {
  try {
    requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const body = await request.json().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body.limit) || 25, 1), 50);
  const items = await prisma.item.findMany({
    where: { status: "listed", shopifyProductId: { not: null }, ...(typeof body.afterId === "string" ? { id: { gt: body.afterId } } : {}) },
    orderBy: { id: "asc" },
    take: limit,
  });
  let done = 0;
  const failed: { sku: string; error: string }[] = [];
  for (const item of items) {
    try {
      if (await refreshShopifyDescription(item)) done++;
    } catch (e) {
      failed.push({ sku: item.sku, error: (e as Error).message.slice(0, 200) });
    }
  }
  return NextResponse.json({ done, failed, nextAfterId: items.length === limit ? items[items.length - 1].id : null });
}
