import {
  getEbayEnvironment,
  getMissingScopes,
  getOrder,
  getOrderEarnings,
  getRecentOrders,
  reviseFixedPriceItemQuantity,
  updateOfferQuantity,
} from "./ebay";
import { prisma } from "./prisma";
import type { Prisma } from "@/generated/prisma/client";

export type EbayOrderSyncResult = {
  skipped?: string;
  ordersScanned: number;
  itemsUpdated: number;
  itemsAlreadySynced: number;
  itemsUnmatched: number;
  refundsRecorded: number;
  salesReversed: number;
  errors: string[];
};

// Order statuses that should NOT be treated as a real sale — a cancelled or
// unpaid order matching a line item here must not permanently mark
// inventory as sold. Matched loosely (includes, not exact) since eBay's
// enum has several paid-adjacent variants (e.g. PARTIALLY_REFUNDED) that
// are still real sales for accounting purposes; only genuinely unpaid/
// cancelled orders are excluded.
const NON_SALE_PAYMENT_STATUSES = ["FAILED", "PENDING", "CANCELLED", "NO_PAYMENT_NEEDED"];

// Confirmed live: eBay's Finances API can take several minutes to post a
// sale's SHIPPING_LABEL transaction after the order itself is created (one
// real order's shipping label posted ~4 minutes after the sale) — a sync
// that runs (or is triggered) right after the sale, before the label
// posts, permanently recorded $0 shipping with no way to ever revisit it,
// since an existing sale row was always skipped outright. A sale still
// missing shipping data gets re-checked against fresh earnings on each
// sync run until it's this many days old, then whatever's on record is
// accepted as final (a listing that genuinely has no shipping label, e.g.
// buyer pickup or free shipping paid outside eBay, would otherwise get
// re-checked forever for no reason). 7, not the original 5 — Cristian:
// some orders take longer to process, and a long weekend can push the
// actual label purchase past 5-6 days.
const SHIPPING_RECHECK_WINDOW_DAYS = 7;

// Same idea, separate window — Cristian: the Promoted Listings "General
// fee" (NON_SALE_CHARGE/AD_FEE, see getOrderEarnings) can take 1-4 days to
// post, not just minutes like a shipping label. NOT gated on Item.ebayAdId
// ("was this ever promoted through this app") — confirmed live that field
// is null on a real order that definitely had an ad fee, so it's not a
// reliable signal (listings can get promoted straight from eBay's Seller
// Hub too, outside this app entirely). There's also no "still missing"
// signal to check the way shippingTransactionId gives one for shipping —
// fees is always a real number, never null — so instead every sale within
// this window gets its fees re-verified against fresh earnings on every
// sync run, whether or not it turns out to have an ad fee. This costs
// nothing extra: earnings for the order are already fetched once per
// order (see earningsCache) for the shipping-label logic regardless, so
// the ad fee data is already sitting right there.
const AD_FEE_RECHECK_WINDOW_DAYS = 4;

// Walks back a previously-recorded sale — used when an order that WAS a
// real, synced sale later transitions to a non-sale payment status (a
// buyer cancellation or a reversed payment after the order had already
// been marked PAID and synced). Confirmed as a real, live gap: the
// original NON_SALE_PAYMENT_STATUSES check only ever prevented recording a
// sale for an order that was ALREADY non-sale the first time it was seen —
// it never looked at whether a previously-good sale needed undoing, so a
// cancelled-after-the-fact order left soldQuantity and revenue/fee/
// shipping totals permanently wrong with nothing to ever correct them.
// Deletes the sale row entirely (and any refunds against it, which cascade
// — see EbayItemRefund's onDelete: Cascade) rather than flagging it
// cancelled, matching how a from-the-start-cancelled order is already
// treated (never recorded at all) — nothing else in the app needs to
// learn to filter out a "reversed" sale this way.
async function reverseSale(
  sale: { id: string; quantity: number; revenue: Prisma.Decimal; fees: Prisma.Decimal; shipping: Prisma.Decimal },
  item: {
    id: string;
    sku: string;
    status: string;
    quantity: number;
    soldQuantity: number;
    ebayOfferId: string | null;
    ebayListingId: string | null;
  }
): Promise<void> {
  const refunds = await prisma.ebayItemRefund.findMany({ where: { saleId: sale.id }, select: { amount: true } });
  const refundedAmount = refunds.reduce((sum, r) => sum + Number(r.amount), 0);
  const newSoldQuantity = Math.max(0, item.soldQuantity - sale.quantity);

  await prisma.$transaction([
    prisma.ebayItemSale.delete({ where: { id: sale.id } }),
    prisma.item.update({
      where: { id: item.id },
      data: {
        soldQuantity: newSoldQuantity,
        soldRevenueTotal: { decrement: sale.revenue },
        soldFeesTotal: { decrement: sale.fees },
        soldShippingTotal: { decrement: sale.shipping },
        ...(refundedAmount > 0 ? { refundedTotal: { decrement: refundedAmount } } : {}),
        // Only walk status back if THIS reversal is what would make it no
        // longer fully sold — never touch a status this sale didn't cause
        // (an item manually set to something else stays that way).
        status: item.status === "sold" && newSoldQuantity < item.quantity ? "listed" : undefined,
      },
    }),
  ]);

  // Push the restored stock back to the live eBay listing too, not just
  // our own records — Cristian asked directly: does eBay itself add
  // cancelled stock back automatically? Everything observed today says no,
  // reliably — the exact listing this whole fix was built around kept
  // showing a stale, un-restored count through multiple real sales and
  // (per Cristian) at least one cancellation. Best-effort: our own DB is
  // already correct even if this push fails, so a failure here is logged,
  // not thrown — it shouldn't take down the rest of the sync run over a
  // single listing's eBay-side push.
  const newAvailableQuantity = Math.max(0, item.quantity - newSoldQuantity);
  try {
    if (item.ebayOfferId) {
      await updateOfferQuantity(item.ebayOfferId, { sku: item.sku, soldQuantity: newSoldQuantity }, newAvailableQuantity);
    } else if (item.ebayListingId) {
      await reviseFixedPriceItemQuantity(item.ebayListingId, item.quantity);
    }
  } catch (e) {
    console.error(`[ebayOrderSync] reverseSale: failed to push restored quantity to eBay for item ${item.id}`, e);
  }
}

// `since`, when passed, overrides the normal incremental watermark — for a
// one-off historical catch-up (e.g. after linking legacy CSV-uploaded
// listings via /api/items/link-legacy, whose sales could predate this sync
// feature entirely and would otherwise never be picked up, since the
// regular run only ever looks forward from the last successful sync).
// `shippingRecheckWindowDays`, when passed, overrides
// SHIPPING_RECHECK_WINDOW_DAYS for both the recheck-due query and the
// in-loop check below — for a one-off backfill of sales that were already
// stuck at $0 shipping before the getOrder-based recheck fetch existed
// (see the comment above the orders-merge block) and have since aged past
// the normal 7-day window, permanently. Not meant for routine use — the
// whole point of the normal window is to eventually stop re-checking a
// sale that genuinely has no shipping label.
export async function syncEbayOrders(
  options?: { since?: Date; shippingRecheckWindowDays?: number }
): Promise<EbayOrderSyncResult> {
  const result: EbayOrderSyncResult = {
    ordersScanned: 0,
    itemsUpdated: 0,
    itemsAlreadySynced: 0,
    itemsUnmatched: 0,
    refundsRecorded: 0,
    salesReversed: 0,
    errors: [],
  };

  const missingScopes = await getMissingScopes();
  if (missingScopes.length > 0) {
    result.skipped = `Missing eBay scopes: ${missingScopes.join(", ")} — reconnect eBay in Settings.`;
    return result;
  }

  const environment = getEbayEnvironment();
  const syncState = await prisma.ebaySyncState.findUnique({ where: { environment } });
  const from = options?.since ?? syncState?.lastOrderSyncAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Captured before calling eBay, not after — an order modified while this
  // run is in flight must still be picked up by the *next* run, not
  // skipped because the watermark already moved past it.
  const syncStartedAt = new Date();

  const earningsCache = new Map<string, Awaited<ReturnType<typeof getOrderEarnings>>>();

  try {
    const orders = await getRecentOrders(from, syncStartedAt);

    // A shipping label purchase doesn't reliably bump an order's
    // lastmodifieddate on eBay's side — confirmed live: orders over 40
    // days old still had a real, unclaimed shipping label sitting on
    // eBay, despite the incremental lastmodifieddate window having long
    // since moved past them. Without this, SHIPPING_RECHECK_WINDOW_DAYS
    // below never actually gets a chance to run for most sales, since
    // getRecentOrders alone would just never surface them again.
    // getOrder (a single-order lookup, not a date-range scan) fills that
    // gap: directly re-fetch any order that still has a sale on record
    // with no shipping data and is still within the recheck window, and
    // fold it into the same orders list so it goes through the identical
    // processing loop below — no separate code path to keep in sync.
    const shippingRecheckWindowDays = options?.shippingRecheckWindowDays ?? SHIPPING_RECHECK_WINDOW_DAYS;
    const shippingRecheckCutoff = new Date(
      syncStartedAt.getTime() - shippingRecheckWindowDays * 24 * 60 * 60 * 1000
    );
    const alreadyFetchedOrderIds = new Set(orders.map((o) => o.orderId));
    const shippingRecheckDueOrderIds = await prisma.ebayItemSale.findMany({
      where: { shipping: 0, shippingTransactionId: null, soldAt: { gte: shippingRecheckCutoff } },
      select: { ebayOrderId: true },
      distinct: ["ebayOrderId"],
    });
    for (const { ebayOrderId } of shippingRecheckDueOrderIds) {
      if (alreadyFetchedOrderIds.has(ebayOrderId)) continue;
      try {
        orders.push(await getOrder(ebayOrderId));
        alreadyFetchedOrderIds.add(ebayOrderId);
      } catch (e) {
        result.errors.push(
          `Order ${ebayOrderId} (shipping recheck fetch): ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    result.ordersScanned = orders.length;

    // Resolve every combine-shipped label's group BEFORE processing
    // individual orders — Cristian: split a shared label's cost evenly
    // across however many orders it covers, rather than the old
    // first-claimer-takes-100%-of-it design. That needs the FULL known
    // membership up front (from this run's orders AND any sibling already
    // recorded from an earlier run), not a one-at-a-time exclusivity
    // claim, since adding a sibling changes everyone's fair share.
    // shippingTransactionId is already a shared, non-unique key across
    // sibling EbayItemSale rows — no schema change needed to group by it.
    const salesOrders = orders.filter((o) => !NON_SALE_PAYMENT_STATUSES.includes(o.orderPaymentStatus));
    const labelOrdersThisRun = new Map<string, Set<string>>();
    const labelAmountByTxnId = new Map<string, number>();
    for (const order of salesOrders) {
      if (!earningsCache.has(order.orderId)) {
        earningsCache.set(order.orderId, await getOrderEarnings(order.orderId));
      }
      const earnings = earningsCache.get(order.orderId)!;
      for (const label of earnings.shippingLabels) {
        const set = labelOrdersThisRun.get(label.transactionId) ?? new Set<string>();
        set.add(order.orderId);
        labelOrdersThisRun.set(label.transactionId, set);
        labelAmountByTxnId.set(label.transactionId, label.amount);
      }
    }

    const resolvedPoolPerOrder = new Map<string, number>();
    const inRunOrderIds = new Set(salesOrders.map((o) => o.orderId));
    for (const [transactionId, inRunSiblingIds] of labelOrdersThisRun) {
      const knownSiblings = await prisma.ebayItemSale.findMany({
        where: { shippingTransactionId: transactionId },
        select: { ebayOrderId: true },
        distinct: ["ebayOrderId"],
      });
      const siblingOrderIds = new Set(knownSiblings.map((s) => s.ebayOrderId));
      for (const id of inRunSiblingIds) siblingOrderIds.add(id);

      const labelAmount = labelAmountByTxnId.get(transactionId)!;
      const sharePerOrder = labelAmount / siblingOrderIds.size;
      resolvedPoolPerOrder.set(transactionId, sharePerOrder);

      // Rebalance whichever siblings this run's main loop won't otherwise
      // touch — already recorded from an earlier run, either a legacy $0
      // "loser" row from the old first-claim design or a previously-
      // resolved nonzero share that needs adjusting now the known group
      // size has changed. Derived entirely from each sale's own stored
      // revenue (no eBay API call needed) — same revenue-proportional
      // split already used within one order's own line items below, just
      // dividing this order's share of the label instead of the full
      // amount.
      for (const siblingOrderId of siblingOrderIds) {
        if (inRunOrderIds.has(siblingOrderId)) continue;
        try {
          const siblingSales = await prisma.ebayItemSale.findMany({ where: { ebayOrderId: siblingOrderId } });
          const orderRevenueTotal = siblingSales.reduce((sum, s) => sum + Number(s.revenue), 0);
          for (const sale of siblingSales) {
            const share = orderRevenueTotal > 0 ? Number(sale.revenue) / orderRevenueTotal : 1 / siblingSales.length;
            const newShipping = share * sharePerOrder;
            const delta = newShipping - Number(sale.shipping);
            if (Math.abs(delta) < 0.005) continue;
            await prisma.$transaction([
              prisma.ebayItemSale.update({
                where: { id: sale.id },
                data: { shipping: newShipping, shippingTransactionId: transactionId },
              }),
              prisma.item.update({ where: { id: sale.itemId }, data: { soldShippingTotal: { increment: delta } } }),
            ]);
          }
        } catch (e) {
          result.errors.push(
            `Order ${siblingOrderId} (shipping rebalance for ${transactionId}): ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }

    for (const order of orders) {
      if (NON_SALE_PAYMENT_STATUSES.includes(order.orderPaymentStatus)) {
        // Might be a real, already-recorded sale that later got cancelled
        // or reversed (PAID -> CANCELLED after the fact) — walk it back if
        // so. An order that was non-sale from the very first time we ever
        // saw it has no existing sale to find, so this is a no-op for the
        // ordinary case, same as before this existed.
        for (const lineItem of order.lineItems) {
          try {
            const existingSale = await prisma.ebayItemSale.findUnique({
              where: { ebayOrderLineItemId: lineItem.lineItemId },
              include: { item: true },
            });
            if (!existingSale) continue;
            await reverseSale(existingSale, existingSale.item);
            result.salesReversed++;
          } catch (e) {
            result.errors.push(
              `Order ${order.orderId} line ${lineItem.lineItemId} (reversal): ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
        continue;
      }

      // Shipping label cost is order-level, not per line item — split it
      // across line items proportional to each one's share of the order's
      // total declared value (same weighting philosophy the manifest
      // reconciliation route already uses for landed cost). Computed from
      // ALL of the order's line items, matched or not, so an order mixing
      // our items with someone else's (a VA's dropshipped item, say) still
      // only attributes our item's fair share, not the whole shipment.
      const orderTotalRevenue = order.lineItems.reduce((sum, li) => sum + li.lineItemCostValue, 0);

      if (!earningsCache.has(order.orderId)) {
        earningsCache.set(order.orderId, await getOrderEarnings(order.orderId));
      }
      const earnings = earningsCache.get(order.orderId)!;

      // This order's even share of each of its shipping labels — already
      // resolved above (across the FULL known sibling group, not just
      // whichever order got here first). Usually 0 or 1 label; more than 1
      // only for a genuinely split shipment, in which case only the last
      // transactionId gets stored as the reference — a rare edge case, not
      // worth a many-to-many schema.
      let orderShippingPool = 0;
      let orderShippingTxnId: string | null = null;
      for (const label of earnings.shippingLabels) {
        orderShippingPool += resolvedPoolPerOrder.get(label.transactionId) ?? 0;
        orderShippingTxnId = label.transactionId;
      }

      for (const lineItem of order.lineItems) {
        try {
          const item = await prisma.item.findUnique({ where: { ebaySku: lineItem.sku } });
          if (!item) {
            result.itemsUnmatched++;
            continue;
          }

          const existingSale = await prisma.ebayItemSale.findUnique({
            where: { ebayOrderLineItemId: lineItem.lineItemId },
          });

          const adFee = item.ebayListingId
            ? earnings.adFees.find((f) => f.legacyItemId === item.ebayListingId)?.amount ?? 0
            : 0;
          const fees = (earnings.lineItemFees.find((e) => e.lineItemId === lineItem.lineItemId)?.totalFees ?? 0) + adFee;
          const shipping =
            orderTotalRevenue > 0 ? (lineItem.lineItemCostValue / orderTotalRevenue) * orderShippingPool : 0;

          if (existingSale) {
            const ageDays = (syncStartedAt.getTime() - existingSale.soldAt.getTime()) / (1000 * 60 * 60 * 24);
            // No "still missing" signal for an ad fee the way shippingTransactionId
            // gives one for shipping — fees is always a real number, never null —
            // so a promoted item's sale is re-checked on every run within its own
            // window regardless of whether the fee already posted, not just once.
            const adFeeRecheckDue = ageDays <= AD_FEE_RECHECK_WINDOW_DAYS;
            // Within at least one recheck window — apply whatever fresh
            // earnings now show as a DELTA against the item's running
            // totals, not a blind re-increment (the sale row already
            // contributed its original fees/shipping once). Epsilon, not
            // === 0 — re-deriving fees/shipping from floats each run vs. a
            // Decimal(10,2) column rounded once at storage time produces
            // sub-cent noise (e.g. 2.6799999999999997 + 1.98 vs. a stored
            // 4.66) that isn't a real correction and shouldn't trigger a
            // write.
            const feesDelta = fees - Number(existingSale.fees);
            const shippingDelta = shipping - Number(existingSale.shipping);
            // Shipping has no age gate here (unlike fees above) — being in
            // `orders` this run already means it was worth fetching
            // earnings for (recently modified, within the shipping
            // recheck window, or a combine-ship sibling whose group just
            // got resolved above), so any real shipping delta — including
            // a PREVIOUSLY nonzero share that needs adjusting because a
            // new sibling joined the group — always gets applied, not
            // re-gated behind a window meant for a different purpose.
            if (!adFeeRecheckDue && Math.abs(shippingDelta) < 0.005) {
              result.itemsAlreadySynced++;
              continue;
            }
            if (Math.abs(feesDelta) < 0.005 && Math.abs(shippingDelta) < 0.005) {
              result.itemsAlreadySynced++;
              continue;
            }
            await prisma.$transaction([
              prisma.ebayItemSale.update({
                where: { id: existingSale.id },
                data: { fees, shipping, shippingTransactionId: orderShippingTxnId ?? existingSale.shippingTransactionId },
              }),
              prisma.item.update({
                where: { id: item.id },
                data: { soldFeesTotal: { increment: feesDelta }, soldShippingTotal: { increment: shippingDelta } },
              }),
            ]);
            result.itemsUpdated++;
            continue;
          }

          const newSoldQuantity = item.soldQuantity + lineItem.quantity;
          await prisma.$transaction([
            prisma.ebayItemSale.create({
              data: {
                itemId: item.id,
                ebayOrderId: order.orderId,
                ebayOrderLineItemId: lineItem.lineItemId,
                quantity: lineItem.quantity,
                revenue: lineItem.lineItemCostValue,
                fees,
                shipping,
                shippingTransactionId: orderShippingTxnId,
                soldAt: new Date(order.creationDate),
              },
            }),
            prisma.item.update({
              where: { id: item.id },
              data: {
                soldQuantity: newSoldQuantity,
                soldRevenueTotal: { increment: lineItem.lineItemCostValue },
                soldFeesTotal: { increment: fees },
                soldShippingTotal: { increment: shipping },
                // Only fully sold-out flips status — a partially-sold
                // multi-unit item stays "listed" with soldQuantity > 0.
                status: newSoldQuantity >= item.quantity ? "sold" : undefined,
              },
            }),
          ]);
          result.itemsUpdated++;
        } catch (e) {
          result.errors.push(
            `Order ${order.orderId} line ${lineItem.lineItemId}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      // Refunds are processed for every scanned order, not just ones with
      // newly-synced line items — a refund can post well after the
      // original sale was already recorded (eBay bumps the order's
      // lastmodifieddate when it does, which is exactly what brings the
      // order back into a later incremental sync's window). Only ever
      // attaches to a sale that already exists in our own data, so a
      // refund on a listing never made through this app has nothing to
      // attach to and is correctly never recorded at all.
      for (const refund of earnings.refunds) {
        try {
          const targetSales =
            refund.affectedLineItemIds.length > 0
              ? await prisma.ebayItemSale.findMany({
                  where: { ebayOrderLineItemId: { in: refund.affectedLineItemIds } },
                })
              : await prisma.ebayItemSale.findMany({ where: { ebayOrderId: order.orderId } });
          if (targetSales.length === 0) continue;

          // No genuine per-line refund-amount breakdown from eBay even
          // when affectedLineItemIds names more than one line (only fee
          // credits are itemized) — split the refund total across
          // whichever of our sales it applies to, proportional to each
          // one's original revenue, same allocation philosophy as the
          // shipping-label split above.
          const totalRevenueOfTargets = targetSales.reduce((sum, s) => sum + Number(s.revenue), 0);
          for (const sale of targetSales) {
            const share = totalRevenueOfTargets > 0 ? Number(sale.revenue) / totalRevenueOfTargets : 1 / targetSales.length;
            const amount = refund.totalAmount * share;
            const feeCredit = refund.totalFeeCredit * share;
            // Composite, not the bare eBay transactionId — one refund
            // transaction can legitimately become several EbayItemRefund
            // rows (one per affected sale), and each needs its own stable
            // idempotency key.
            const compositeId = `${refund.transactionId}:${sale.id}`;

            const alreadyRecorded = await prisma.ebayItemRefund.findUnique({
              where: { ebayRefundTransactionId: compositeId },
              select: { id: true },
            });
            if (alreadyRecorded) continue;

            await prisma.$transaction([
              prisma.ebayItemRefund.create({
                data: {
                  saleId: sale.id,
                  ebayRefundTransactionId: compositeId,
                  amount,
                  feeCredit,
                  refundedAt: new Date(refund.refundedAt),
                },
              }),
              prisma.item.update({ where: { id: sale.itemId }, data: { refundedTotal: { increment: amount } } }),
            ]);
            result.refundsRecorded++;
          }
        } catch (e) {
          result.errors.push(
            `Order ${order.orderId} refund ${refund.transactionId}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }
  } catch (e) {
    result.errors.push(`Fetching orders failed: ${e instanceof Error ? e.message : String(e)}`);
    // Don't advance the watermark below — the whole window gets retried
    // next run. Per-line-item checkpoints (ebayOrderLineItemId) make that
    // safe, not wasteful.
    return result;
  }

  await prisma.ebaySyncState.upsert({
    where: { environment },
    create: { environment, lastOrderSyncAt: syncStartedAt },
    update: { lastOrderSyncAt: syncStartedAt },
  });

  return result;
}
