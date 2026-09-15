import { getEbayEnvironment, getMissingScopes, getOrderEarnings, getRecentOrders } from "./ebay";
import { prisma } from "./prisma";

export type EbayOrderSyncResult = {
  skipped?: string;
  ordersScanned: number;
  itemsUpdated: number;
  itemsAlreadySynced: number;
  itemsUnmatched: number;
  errors: string[];
};

// Order statuses that should NOT be treated as a real sale — a cancelled or
// unpaid order matching a line item here must not permanently mark
// inventory as sold. Matched loosely (includes, not exact) since eBay's
// enum has several paid-adjacent variants (e.g. PARTIALLY_REFUNDED) that
// are still real sales for accounting purposes; only genuinely unpaid/
// cancelled orders are excluded.
const NON_SALE_PAYMENT_STATUSES = ["FAILED", "PENDING", "CANCELLED", "NO_PAYMENT_NEEDED"];

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
    result.ordersScanned = orders.length;

    for (const order of orders) {
      if (NON_SALE_PAYMENT_STATUSES.includes(order.orderPaymentStatus)) continue;

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
          if (existingSale) {
            result.itemsAlreadySynced++;
            continue;
          }

          if (!earningsCache.has(order.orderId)) {
            earningsCache.set(order.orderId, await getOrderEarnings(order.orderId));
          }
          const earnings = earningsCache.get(order.orderId) ?? [];
          const fees = earnings.find((e) => e.lineItemId === lineItem.lineItemId)?.totalFees ?? 0;

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
                soldAt: new Date(order.creationDate),
              },
            }),
            prisma.item.update({
              where: { id: item.id },
              data: {
                soldQuantity: newSoldQuantity,
                soldRevenueTotal: { increment: lineItem.lineItemCostValue },
                soldFeesTotal: { increment: fees },
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
