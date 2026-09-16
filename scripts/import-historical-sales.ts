// One-off pull of the last year of real eBay sold orders into
// HistoricalSaleRecord — a standalone reference table the sourcing agent
// reads for "have we sold this brand/product before, at what price" when a
// candidate manifest line has no match in our own Item/EbayItemSale
// history (most real sales predate this app, or were never scanned/listed
// through it at all). Deliberately NOT linked to Item/Manifest and NOT
// surfaced on the dashboard or manifest pages — Cristian asked for a
// reference dataset for the agent only, not an import into his tracked
// numbers.
//
// Includes everything on the account, including whatever belongs to the
// VA's separate dropshipping listings sharing this eBay account — there's
// no reliable way to tell those apart from real liquidation-resale sales,
// and Cristian explicitly said to include everything rather than try.
//
// Idempotent — ebayOrderLineItemId is unique, so re-running only adds
// orders/lines not already imported.
//
//   npx tsx scripts/import-historical-sales.ts
//
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

async function main() {
  const { PrismaClient } = await import("../src/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { getRecentOrders, getOrderEarnings } = await import("../src/lib/ebay");

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const to = new Date();
  const from = new Date(to.getTime() - ONE_YEAR_MS);
  console.log(`Fetching orders from ${from.toISOString()} to ${to.toISOString()}...`);

  const orders = await getRecentOrders(from, to);
  console.log(`${orders.length} order(s) found.`);

  // Same combine-shipping dedup philosophy as ebayOrderSync.ts: eBay
  // returns the identical shipping-label transaction for every order in a
  // combined shipment, so naively summing per order multiplies the real
  // cost. This is a single run over the whole year, not an incremental
  // sync, so an in-memory claim set (first order to see a transactionId
  // keeps it) is enough — no need for the DB cross-check ebayOrderSync.ts
  // does across separate runs.
  const claimedShippingTxnIds = new Set<string>();
  const earningsCache = new Map<string, Awaited<ReturnType<typeof getOrderEarnings>>>();

  let imported = 0;
  let alreadyImported = 0;
  let errors = 0;

  for (const [i, order] of orders.entries()) {
    if (i > 0 && i % 100 === 0) console.log(`...${i}/${orders.length} orders processed`);

    if (order.lineItems.length === 0) continue;

    try {
      if (!earningsCache.has(order.orderId)) {
        earningsCache.set(order.orderId, await getOrderEarnings(order.orderId));
      }
      const earnings = earningsCache.get(order.orderId)!;

      const orderTotalRevenue = order.lineItems.reduce((sum, li) => sum + li.lineItemCostValue, 0);

      let orderShippingPool = 0;
      for (const label of earnings.shippingLabels) {
        if (claimedShippingTxnIds.has(label.transactionId)) continue;
        claimedShippingTxnIds.add(label.transactionId);
        orderShippingPool += label.amount;
      }

      for (const li of order.lineItems) {
        const existing = await prisma.historicalSaleRecord.findUnique({
          where: { ebayOrderLineItemId: li.lineItemId },
          select: { id: true },
        });
        if (existing) {
          alreadyImported++;
          continue;
        }

        const fees = earnings.lineItemFees.find((e) => e.lineItemId === li.lineItemId)?.totalFees ?? 0;
        const shipping =
          orderTotalRevenue > 0 ? (li.lineItemCostValue / orderTotalRevenue) * orderShippingPool : 0;

        await prisma.historicalSaleRecord.create({
          data: {
            ebayOrderId: order.orderId,
            ebayOrderLineItemId: li.lineItemId,
            title: li.title,
            quantity: li.quantity,
            soldPrice: li.lineItemCostValue,
            shippingCost: shipping,
            fees,
            soldAt: new Date(order.creationDate),
          },
        });
        imported++;
      }
    } catch (e) {
      errors++;
      console.error(`Order ${order.orderId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`Done. Imported ${imported} new line(s), ${alreadyImported} already present, ${errors} error(s).`);
  await prisma.$disconnect();
}

main();
