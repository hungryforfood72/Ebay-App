import {
  EbayApiError,
  getLiveAvailableQuantity,
  reviseFixedPriceItemQuantity,
  updateOfferQuantity,
} from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { queueShopifySync } from "@/lib/shopifySync";
import { removeUnitsBestEffort } from "@/lib/warehouse/bins";
import { classifyScan } from "@/lib/warehouse/codes";

// Adds or removes stock on a live listing by a signed delta. Moved here
// from PATCH /api/items/[id]/quantity (which now just wraps it, same
// answers and statuses as before) so a same-condition return can put its
// units back on the listing the exact same way (src/lib/warehouse/returns.ts).
//
// Why a delta rather than setting an absolute target — Cristian's explicit
// reasoning: typing a new absolute total based on whatever the screen
// showed when editing started is a race against a real-time sale. If 5
// were available when the edit opened and he means "add 5 more", typing
// "10" silently overwrites a sale that completed in between (say it's
// really down to 4 by submit time — the correct new total is 9, not 10).
// Computing from a fresh live eBay check taken right here, at write time,
// instead of whatever was on screen when editing started, closes that
// window (not perfectly against another *simultaneous* request — a small
// residual race any multi-writer system has — but it eliminates the
// specific "I was mid-edit" gap this was asked to fix). Every adjustment
// requires a note, recorded permanently via StockAdjustment regardless of
// whether the eBay push itself succeeds (the intent behind the change is
// worth keeping even if eBay was unreachable) — see the model's own comment
// for why it also doubles as the real record of what was true when the
// change happened, not just an audit note.
export type StockAdjustResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

export async function adjustItemStock(args: {
  itemId: string;
  direction: unknown;
  amount: unknown;
  note: unknown;
  recordedBy: string | null;
}): Promise<StockAdjustResult> {
  const id = args.itemId;
  const recordedBy = args.recordedBy;
  const direction = args.direction === "add" || args.direction === "remove" ? args.direction : null;
  const amount = Number(args.amount);
  const note = typeof args.note === "string" ? args.note.trim() : "";

  if (!direction) {
    return { ok: false, status: 400, error: "direction must be 'add' or 'remove'." };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, status: 400, error: "amount must be a whole number greater than 0." };
  }
  if (!note) {
    return { ok: false, status: 400, error: "A note is required for every stock change." };
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return { ok: false, status: 404, error: "Item not found." };
  }
  if (!item.ebayOfferId && !item.ebayListingId && !item.shopifyOnly) {
    return { ok: false, status: 400, error: "This item isn't currently listed on eBay." };
  }

  // The freshest truth available right now — a live eBay check, falling
  // back to our own stored figure only if that check fails. This is what
  // the delta gets applied against, not whatever the client last saw.
  const storedAvailableQuantity = Math.max(0, item.quantity - item.soldQuantity);
  const offEbay = item.shopifyOnly || Boolean(item.pastDateAt);
  const currentAvailableQuantity = (offEbay ? null : await getLiveAvailableQuantity(item)) ?? storedAvailableQuantity;

  const signedDelta = direction === "add" ? amount : -amount;
  const newAvailableQuantity = currentAvailableQuantity + signedDelta;
  if (newAvailableQuantity < 0) {
    return {
      ok: false,
      status: 400,
      error: `Only ${currentAvailableQuantity} currently available — can't remove ${amount}.`,
    };
  }

  try {
    let newQuantity: number;
    if (offEbay) {
      // Not on eBay (Shopify & Whatnot only, or past-date): nothing there to
      // change. Shopify follows through queueShopifySync below.
      newQuantity = newAvailableQuantity + item.soldQuantity;
    } else if (item.ebayOfferId) {
      newQuantity = await updateOfferQuantity(item.ebayOfferId, item, newAvailableQuantity);
    } else {
      newQuantity = newAvailableQuantity + item.soldQuantity;
      await reviseFixedPriceItemQuantity(item.ebayListingId!, newAvailableQuantity);
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
          recordedBy,
        },
      }),
    ]);
    queueShopifySync([id]);
    // Warehouse mode: removed stock comes out of the item's bins (oldest
    // placement first) so a picker isn't sent for units that are gone.
    // Its own step after the adjustment is saved: eBay has already changed,
    // so a busy bin must never undo the stock record. Added stock is NOT
    // put in a bin automatically: nobody knows which bin it physically went
    // into until someone scans it (Fill bins / Put away). Items with no bins
    // are untouched either way.
    const bins =
      signedDelta < 0
        ? await removeUnitsBestEffort({ itemId: id, units: amount, kind: "adjust", by: recordedBy, note })
        : { taken: [], binsUpdated: true };
    // Items with a warehouse label belong in bins even when none hold them
    // right now (all picked, then restocked).
    const usesBins =
      classifyScan(item.sku) === "item" ||
      bins.taken.length > 0 ||
      (await prisma.binContent.count({ where: { itemId: id } })) > 0;
    return {
      ok: true,
      body: {
        ...updated,
        availableQuantity: Math.max(0, updated.quantity - updated.soldQuantity),
        adjustment,
        fromBins: bins.taken,
        binsUpdated: bins.binsUpdated,
        // Set when added units still need scanning into a bin.
        putAway: signedDelta > 0 && usesBins ? { units: amount } : null,
      },
    };
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
        recordedBy,
      },
    });
    return { ok: false, status: 502, error: message };
  }
}
