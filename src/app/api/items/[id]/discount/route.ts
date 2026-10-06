import { computeDiscountedPrice, discountBasePrice } from "@/lib/discount";
import { ownerOnly } from "@/lib/auth";
import { EbayApiError, reviseFixedPriceItemPrice, toItemForEbayPublish, updateOfferPrice } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Single-item counterpart to /api/manifests/[id]/discount — used from the
// dashboard's expiring-item cards where Cristian acts on one listing at a
// time rather than a whole manifest. Supports two kinds of listings: ones
// published through this app's Inventory API flow (has ebayOfferId, price
// changes via updateOfferPrice) and ones that were only ever bulk-uploaded
// via the old File Exchange CSV and later linked up by /api/items/link-legacy
// (has ebayListingId but no ebayOfferId — those aren't Inventory API
// "offers" at all, so price changes go through the Trading API instead).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const mode = body.mode === "amount" ? "amount" : body.mode === "percent" ? "percent" : null;
  const value = Number(body.value);
  // 0 is allowed: back to the original price.
  if (!mode || !Number.isFinite(value) || value < 0 || (mode === "percent" && value >= 100)) {
    return NextResponse.json({ error: "Enter a discount from 0 up to (not including) 100%." }, { status: 400 });
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayOfferId && !item.ebayListingId) {
    return NextResponse.json({ error: "This item isn't currently listed on eBay." }, { status: 400 });
  }

  const basePrice = await discountBasePrice(item);
  const newPrice = computeDiscountedPrice(basePrice, mode, value);

  try {
    if (item.ebayOfferId) {
      await updateOfferPrice(item.ebayOfferId, toItemForEbayPublish(item, newPrice), newPrice);
    } else {
      await reviseFixedPriceItemPrice(item.ebayListingId!, newPrice);
    }
    const updated = await prisma.item.update({ where: { id }, data: { price: newPrice, originalPrice: basePrice } });
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Discount failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
