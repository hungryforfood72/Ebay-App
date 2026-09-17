import { getEbayEnvironment, getMissingScopes, getOrderEarnings, getRecentOrders } from "./ebay";
import { prisma } from "./prisma";

export type EbayOrderSyncResult = {
  skipped?: string;
  ordersScanned: number;
  itemsUpdated: number;
  itemsAlreadySynced: number;
  itemsUnmatched: number;
  refundsRecorded: number;
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

// `since`, when passed, overrides the normal incremental watermark — for a
// one-off historical catch-up (e.g. after linking legacy CSV-uploaded
// listings via /api/items/link-legacy, whose sales could predate this sync
// feature entirely and would otherwise never be picked up, since the
// regular run only ever looks forward from the last successful sync).
export async function syncEbayOrders(options?: { since?: Date }): Promise<EbayOrderSyncResult> {
  const result: EbayOrderSyncResult = {
    ordersScanned: 0,
    itemsUpdated: 0,
    itemsAlreadySynced: 0,
    itemsUnmatched: 0,
    refundsRecorded: 0,
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
  // Shipping-label transactions claimed so far *in this run* — Cristian
  // combine-ships multiple eBay orders under one physical label, and eBay
  // returns the same shipping transaction for every order in the shipment.
  // Without this, each sibling order would independently allocate the
  // FULL label cost to itself, multiplying the real cost by however many
  // orders shared it. Whichever order is processed first claims the label;
  // the DB check below (ebayOrderId: { not: order.orderId }) makes this
  // durable across separate sync runs too, not just within one.
  const claimedShippingTxnIdsThisRun = new Set<string>();

  try {
    const orders = await getRecentOrders(from, syncStartedAt);
    result.ordersScanned = orders.length;

    for (const order of orders) {
      if (NON_SALE_PAYMENT_STATUSES.includes(order.orderPaymentStatus)) continue;

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

      // Claim whichever of this order's shipping labels haven't already
      // been claimed by a sibling order (this run or a previous one).
      // Usually 0 or 1 label; more than 1 only for a genuinely split
      // shipment, in which case only the last transactionId gets stored as
      // the reference — a rare edge case, not worth a many-to-many schema.
      let orderShippingPool = 0;
      let orderShippingTxnId: string | null = null;
      for (const label of earnings.shippingLabels) {
        if (claimedShippingTxnIdsThisRun.has(label.transactionId)) continue;
        const claimedByAnotherOrder = await prisma.ebayItemSale.findFirst({
          where: { shippingTransactionId: label.transactionId, ebayOrderId: { not: order.orderId } },
          select: { id: true },
        });
        if (claimedByAnotherOrder) continue;
        orderShippingPool += label.amount;
        orderShippingTxnId = label.transactionId;
        claimedShippingTxnIdsThisRun.add(label.transactionId);
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
            const shippingRecheckDue =
              Number(existingSale.shipping) === 0 && !existingSale.shippingTransactionId && ageDays <= SHIPPING_RECHECK_WINDOW_DAYS;
            // No "still missing" signal for an ad fee the way shippingTransactionId
            // gives one for shipping — fees is always a real number, never null —
            // so a promoted item's sale is re-checked on every run within its own
            // window regardless of whether the fee already posted, not just once.
            const adFeeRecheckDue = ageDays <= AD_FEE_RECHECK_WINDOW_DAYS;
            if (!shippingRecheckDue && !adFeeRecheckDue) {
              result.itemsAlreadySynced++;
              continue;
            }
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
