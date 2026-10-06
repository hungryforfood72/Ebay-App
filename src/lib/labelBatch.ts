import { getOrderEarnings, getOrderIdsCreatedBetween } from "./ebay";
import { prisma } from "./prisma";

type Earnings = Awaited<ReturnType<typeof getOrderEarnings>>;

// How far back an order in a label batch can have been placed. Labels go
// out within a few days of the sale; three weeks leaves plenty of slack.
const BATCH_LOOKBACK_DAYS = 21;
// eBay can date a label slightly before an order in its batch (confirmed
// live: an order created 11 minutes after the bulk label charge it's on).
const BATCH_LOOKAHEAD_DAYS = 1;
const CONCURRENCY = 5;

// How many orders one SHIPPING_LABEL charge covers, across the seller's
// whole account. Buying labels in bulk posts ONE charge for the batch and
// eBay ties it to every order in it, the VA's included, with no per-order
// breakdown anywhere (the Finances API gives only the lump sum; Trading
// GetOrders' ActualShippingCost comes back 0). Confirmed live 2026-10-06:
// a $106.99 charge covered 14 orders, only 3 tracked here, and splitting it
// 3-4 ways put $26.75 on each of ours instead of about $7.64.
//
// Counted once per charge and saved: finding the batch means checking
// every order from the weeks around the label against the Finances API.
// Orders already looked up this run are reused from earningsCache.
export async function labelBatchOrderCount(
  label: { transactionId: string; amount: number; date: string },
  earningsCache: Map<string, Earnings>
): Promise<number> {
  const saved = await prisma.shippingLabelBatch.findUnique({ where: { transactionId: label.transactionId } });
  if (saved) return saved.orderCount;

  const labelDate = new Date(label.date);
  if (Number.isNaN(labelDate.getTime())) throw new Error(`label ${label.transactionId} has no usable date`);
  const day = 24 * 60 * 60 * 1000;
  const from = new Date(labelDate.getTime() - BATCH_LOOKBACK_DAYS * day);
  const to = new Date(Math.min(Date.now(), labelDate.getTime() + BATCH_LOOKAHEAD_DAYS * day));
  const orderIds = await getOrderIdsCreatedBetween(from, to);

  let count = 0;
  for (let i = 0; i < orderIds.length; i += CONCURRENCY) {
    const chunk = orderIds.slice(i, i + CONCURRENCY);
    const earnings = await Promise.all(
      chunk.map(async (id) => {
        if (!earningsCache.has(id)) earningsCache.set(id, await getOrderEarnings(id));
        return earningsCache.get(id)!;
      })
    );
    count += earnings.filter((e) => e.shippingLabels.some((l) => l.transactionId === label.transactionId)).length;
  }
  // The order that brought this label up is in the batch by definition; a
  // 0 would mean the window missed it, so never divide by less than 1.
  const orderCount = Math.max(count, 1);

  await prisma.shippingLabelBatch.create({
    data: { transactionId: label.transactionId, amount: label.amount, orderCount, labelDate },
  });
  return orderCount;
}
