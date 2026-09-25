import { computeDiscountedPrice } from "@/lib/discount";
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
  if (!mode || !value || value <= 0) {
    return NextResponse.json({ error: "A discount mode and positive value are required." }, { status: 400 });
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayOfferId && !item.ebayListingId) {
    return NextResponse.json({ error: "This item isn't currently listed on eBay." }, { status: 400 });
  }

  const newPrice = computeDiscountedPrice(Number(item.price ?? 0), mode, value);

  try {
    if (item.ebayOfferId) {
      await updateOfferPrice(item.ebayOfferId, toItemForEbayPublish(item, newPrice), newPrice);
    } else {
      await reviseFixedPriceItemPrice(item.ebayListingId!, newPrice);
    }
    const updated = await prisma.item.update({ where: { id }, data: { price: newPrice } });
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Discount failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
