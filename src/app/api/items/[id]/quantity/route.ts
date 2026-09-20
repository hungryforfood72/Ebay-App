import {
  EbayApiError,
  getOfferDetails,
  reviseFixedPriceItemQuantity,
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

  const recentAdjustments = await prisma.stockAdjustment.findMany({
    where: { itemId: id },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  if (!item.ebayOfferId) {
    return NextResponse.json({
      liveAvailableQuantity: null,
      livePrice: null,
      storedAvailableQuantity,
      recentAdjustments,
    });
  }

  const live = await getOfferDetails(item.ebayOfferId);
  return NextResponse.json({
    liveAvailableQuantity: live?.availableQuantity ?? null,
    livePrice: live?.price ?? null,
    storedAvailableQuantity,
    recentAdjustments,
  });
}

// Adds or removes stock by a signed delta rather than setting an absolute
// target — Cristian's explicit reasoning: typing a new absolute total
// based on whatever the screen showed when editing started is a race
// against a real-time sale. If 5 were available when the edit opened and
// he means "add 5 more", typing "10" silently overwrites a sale that
// completed in between (say it's really down to 4 by submit time — the
// correct new total is 9, not 10). Computing from a fresh live eBay check
// taken right here, at write time, instead of whatever was on screen when
// editing started, closes that window (not perfectly against another
// *simultaneous* request — a small residual race any multi-writer system
// has — but it eliminates the specific "I was mid-edit" gap this was
// asked to fix). Every adjustment requires a note, recorded permanently
// via StockAdjustment regardless of whether the eBay push itself succeeds
// (the intent behind the change is worth keeping even if eBay was
// unreachable) — see the model's own comment for why it also doubles as
// the real record of what was true when the change happened, not just an
// audit note.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const direction = body.direction === "add" || body.direction === "remove" ? body.direction : null;
  const amount = Number(body.amount);
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (!direction) {
    return NextResponse.json({ error: "direction must be 'add' or 'remove'." }, { status: 400 });
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount must be a whole number greater than 0." }, { status: 400 });
  }
  if (!note) {
    return NextResponse.json({ error: "A note is required for every stock change." }, { status: 400 });
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayOfferId && !item.ebayListingId) {
    return NextResponse.json({ error: "This item isn't currently listed on eBay." }, { status: 400 });
  }

  // The freshest truth available right now — a live eBay check when
  // there's an offer to check, falling back to our own stored figure only
  // if that check fails or isn't applicable. This is what the delta gets
  // applied against, not whatever the client last saw.
  const storedAvailableQuantity = Math.max(0, item.quantity - item.soldQuantity);
  const live = item.ebayOfferId ? await getOfferDetails(item.ebayOfferId) : null;
  const currentAvailableQuantity = live?.availableQuantity ?? storedAvailableQuantity;

  const signedDelta = direction === "add" ? amount : -amount;
  const newAvailableQuantity = currentAvailableQuantity + signedDelta;
  if (newAvailableQuantity < 0) {
    return NextResponse.json(
      {
        error: `Only ${currentAvailableQuantity} currently available — can't remove ${amount}.`,
      },
      { status: 400 }
    );
  }

  try {
    let newQuantity: number;
    if (item.ebayOfferId) {
      newQuantity = await updateOfferQuantity(item.ebayOfferId, item, newAvailableQuantity);
    } else {
      newQuantity = newAvailableQuantity + item.soldQuantity;
      await reviseFixedPriceItemQuantity(item.ebayListingId!, newQuantity);
    }
    const [updated, adjustment] = await prisma.$transaction([
      prisma.item.update({ where: { id }, data: { quantity: newQuantity } }),
      prisma.stockAdjustment.create({
        data: {
          itemId: id,
          delta: signedDelta,
          previousAvailable: currentAvailableQuantity,
          newAvailable: newAvailableQuantity,
          note,
        },
      }),
    ]);
    return NextResponse.json({
      ...updated,
      availableQuantity: Math.max(0, updated.quantity - updated.soldQuantity),
      adjustment,
    });
  } catch (e) {
    // The eBay push failed — still record the attempted adjustment (with
    // the error folded into the note) so the intent isn't silently lost,
    // but don't touch the item's own quantity since nothing actually
    // changed on the live listing.
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Failed to update quantity.";
    await prisma.stockAdjustment.create({
      data: {
        itemId: id,
        delta: signedDelta,
        previousAvailable: currentAvailableQuantity,
        newAvailable: currentAvailableQuantity,
        note: `${note} [FAILED: ${message}]`,
      },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
