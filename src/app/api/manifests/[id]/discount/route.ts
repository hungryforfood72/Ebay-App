import { computeDiscountedPrice } from "@/lib/discount";
import { EbayApiError, toItemForEbayPublish, updateOfferPrice } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 90;

// Manual, human-triggered discount of every still-"listed" (published, not
// sold) item in a manifest, relative to each item's own current price —
// not one shared target price, since a manifest's items are rarely priced
// the same to begin with. Called from the manifest dashboard's discount
// section, with a confirm() step client-side since it changes real live
// eBay prices.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const mode = body.mode === "amount" ? "amount" : body.mode === "percent" ? "percent" : null;
  const value = Number(body.value);
  if (!mode || !value || value <= 0) {
    return NextResponse.json({ error: "A discount mode and positive value are required." }, { status: 400 });
  }

  const items = await prisma.item.findMany({
    where: { manifestId: id, status: "listed", ebaySku: { not: null }, ebayOfferId: { not: null } },
  });
  if (items.length === 0) {
    return NextResponse.json({ error: "No listed, unsold items in this manifest to discount." }, { status: 400 });
  }

  const failed: { itemId: string; title: string; message: string }[] = [];
  let updated = 0;

  // Sequential, not parallel — same reasoning as the review page's bulk
  // publish: keeps failures attributable to a specific item and avoids
  // bursting eBay with simultaneous requests.
  for (const item of items) {
    const newPrice = computeDiscountedPrice(Number(item.price ?? 0), mode, value);

    try {
      await updateOfferPrice(item.ebayOfferId!, toItemForEbayPublish(item, newPrice), newPrice);
      await prisma.item.update({ where: { id: item.id }, data: { price: newPrice } });
      updated++;
    } catch (e) {
      const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Update failed.";
      failed.push({ itemId: item.id, title: item.finalTitle ?? item.sku, message });
    }
  }

  return NextResponse.json({ updated, failed });
}
