// One-off correction pass over every existing EbayItemSale row — fixes two
// bugs found live (see commit history): (1) Promoted Listings ad fees were
// never captured at all (a completely separate Finances API transaction,
// NON_SALE_CHARGE/AD_FEE, not part of the SALE transaction), so every
// promoted item's `fees` was understated; (2) shipping-label transactions
// can post several minutes after a sale, and a sale synced before that
// happened permanently recorded $0 shipping with no way to revisit it. The
// ongoing sync (ebayOrderSync.ts) now handles both going forward — this
// script is the one-time catch-up for sales that already exist.
//
// Safe to re-run: only ever applies a DELTA against each sale's current
// fees/shipping, and re-derives from eBay's current Finances API state each
// time, so a second run against already-corrected data is a no-op.
//
//   npx tsx scripts/backfill-shipping-and-ad-fees.ts
//
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

async function main() {
  const { PrismaClient } = await import("../src/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { getOrderEarnings, getOrder } = await import("../src/lib/ebay");

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const sales = await prisma.ebayItemSale.findMany({
    include: { item: { select: { id: true, sku: true, ebayListingId: true } } },
    orderBy: { ebayOrderId: "asc" },
  });

  const orderIds = [...new Set(sales.map((s) => s.ebayOrderId))];
  console.log(`${sales.length} sale row(s) across ${orderIds.length} unique order(s).`);

  let feesFixed = 0;
  let shippingFixed = 0;
  let totalFeesDelta = 0;
  let totalShippingDelta = 0;

  for (const orderId of orderIds) {
    const salesInOrder = sales.filter((s) => s.ebayOrderId === orderId);
    try {
      const [order, earnings] = await Promise.all([getOrder(orderId), getOrderEarnings(orderId)]);
      const orderTotalRevenue = order.lineItems.reduce((sum, li) => sum + li.lineItemCostValue, 0);

      for (const sale of salesInOrder) {
        const adFee = sale.item.ebayListingId
          ? earnings.adFees.find((f) => f.legacyItemId === sale.item.ebayListingId)?.amount ?? 0
          : 0;
        const lineFee = earnings.lineItemFees.find((e) => e.lineItemId === sale.ebayOrderLineItemId)?.totalFees ?? 0;
        const correctedFees = lineFee + adFee;

        let correctedShipping = Number(sale.shipping);
        let correctedShippingTxnId = sale.shippingTransactionId;
        const missingShipping = Number(sale.shipping) === 0 && !sale.shippingTransactionId;
        if (missingShipping && orderTotalRevenue > 0) {
          for (const label of earnings.shippingLabels) {
            const claimedElsewhere = await prisma.ebayItemSale.findFirst({
              where: { shippingTransactionId: label.transactionId, ebayOrderId: { not: orderId } },
              select: { id: true },
            });
            if (claimedElsewhere) continue;
            correctedShipping = (Number(sale.revenue) / orderTotalRevenue) * label.amount;
            correctedShippingTxnId = label.transactionId;
            break;
          }
        }

        // Epsilon, not === 0 — re-deriving from floats each run vs. a
        // Decimal(10,2) column rounded once at storage produces sub-cent
        // noise (e.g. 2.6799999999999997 + 1.98 vs. a stored 4.66) that
        // isn't a real correction and shouldn't count as one.
        const feesDelta = correctedFees - Number(sale.fees);
        const shippingDelta = correctedShipping - Number(sale.shipping);
        if (Math.abs(feesDelta) < 0.005 && Math.abs(shippingDelta) < 0.005) continue;

        await prisma.$transaction([
          prisma.ebayItemSale.update({
            where: { id: sale.id },
            data: { fees: correctedFees, shipping: correctedShipping, shippingTransactionId: correctedShippingTxnId },
          }),
          prisma.item.update({
            where: { id: sale.item.id },
            data: { soldFeesTotal: { increment: feesDelta }, soldShippingTotal: { increment: shippingDelta } },
          }),
        ]);

        if (Math.abs(feesDelta) >= 0.005) {
          feesFixed++;
          totalFeesDelta += feesDelta;
          console.log(`  [fees]     order ${orderId} line ${sale.ebayOrderLineItemId} (${sale.item.sku}): ${Number(sale.fees).toFixed(2)} -> ${correctedFees.toFixed(2)}`);
        }
        if (Math.abs(shippingDelta) >= 0.005) {
          shippingFixed++;
          totalShippingDelta += shippingDelta;
          console.log(`  [shipping] order ${orderId} line ${sale.ebayOrderLineItemId} (${sale.item.sku}): ${Number(sale.shipping).toFixed(2)} -> ${correctedShipping.toFixed(2)}`);
        }
      }
    } catch (e) {
      console.error(`Order ${orderId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\nDone. Fixed fees on ${feesFixed} row(s) (total delta $${totalFeesDelta.toFixed(2)}), shipping on ${shippingFixed} row(s) (total delta $${totalShippingDelta.toFixed(2)}).`);
  await prisma.$disconnect();
}

main();
