import {
  EbayApiError,
  getOfferDetails,
  reviseFixedPriceItemQuantity,
  toItemForEbayPublish,
  updateOfferQuantity,
} from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Live, authoritative check of what's actually available on the real eBay
// listing right now — the whole point of this route existing separately
// from the item's own GET is that the DB's own availableQuantity can be
// stale (see the ItemForEbayPublish comment in ebay.ts for the confirmed
// real bug this shipped alongside: a partially-sold listing's live
// quantity could silently get reset by an unrelated price update). Only
// meaningful for an Inventory-API-published item (has ebayOfferId) — a
// classic/Trading-API listing has no cheap live-read wired up here yet
// (none of today's active listings are that kind), so it just echoes the
// stored value back.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }

  const storedAvailableQuantity = Math.max(0, item.quantity - item.soldQuantity);

  if (!item.ebayOfferId) {
    return NextResponse.json({ liveAvailableQuantity: null, livePrice: null, storedAvailableQuantity });
  }

  const live = await getOfferDetails(item.ebayOfferId);
  return NextResponse.json({
    liveAvailableQuantity: live?.availableQuantity ?? null,
    livePrice: live?.price ?? null,
    storedAvailableQuantity,
  });
}

// Sets the live available-to-buy quantity directly — the actual fix for
// eBay's Seller Hub blocking manual quantity edits on API-managed listings
// ("Inventory-based listing management is not currently supported by this
// tool... refer to the tool used to create this listing" — this route IS
// that tool).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const newAvailableQuantity = Number(body.availableQuantity);
  if (!Number.isInteger(newAvailableQuantity) || newAvailableQuantity < 0) {
    return NextResponse.json({ error: "availableQuantity must be a non-negative whole number." }, { status: 400 });
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayOfferId && !item.ebayListingId) {
    return NextResponse.json({ error: "This item isn't currently listed on eBay." }, { status: 400 });
  }

  try {
    let newQuantity: number;
    if (item.ebayOfferId) {
      newQuantity = await updateOfferQuantity(item.ebayOfferId, toItemForEbayPublish(item), newAvailableQuantity);
    } else {
      newQuantity = newAvailableQuantity + item.soldQuantity;
      await reviseFixedPriceItemQuantity(item.ebayListingId!, newQuantity);
    }
    const updated = await prisma.item.update({ where: { id }, data: { quantity: newQuantity } });
    return NextResponse.json({
      ...updated,
      availableQuantity: Math.max(0, updated.quantity - updated.soldQuantity),
    });
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Failed to update quantity.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
