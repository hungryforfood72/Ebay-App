import { cogsPerUnitByManifest } from "./cogs";
import { prisma } from "./prisma";

export type SalesSummary = {
  units: number;
  revenue: number;
  fees: number;
  shipping: number;
  refunded: number;
  profit: number;
};

// Sales, refunds and profit for app-tracked eBay sales in [from, to) —
// either bound null for open-ended. Sales are scoped by when they sold,
// refunds by when the refund itself posted (not the original sale date): a
// September refund on an August sale belongs in September's numbers.
// EbayItemRefund can only exist attached to an EbayItemSale, so both are
// automatically scoped to app-tracked listings only.
export async function salesSummary(from: Date | null, to: Date | null): Promise<SalesSummary> {
  const range = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } : undefined;

  const [sales, refunds] = await Promise.all([
    // Full rows, not an aggregate — computing profit needs each sale's item
    // (for manifestId/upc/multipack) to look up COGS, which a plain _sum
    // can't give us.
    prisma.ebayItemSale.findMany({
      where: { soldAt: range },
      select: {
        quantity: true,
        revenue: true,
        fees: true,
        shipping: true,
        item: { select: { manifestId: true, upc: true, isMultipack: true, packSize: true } },
      },
    }),
    prisma.ebayItemRefund.findMany({
      where: { refundedAt: range },
      select: { amount: true, feeCredit: true },
    }),
  ]);

  // COGS is manifest-derived — fetch each distinct manifest's per-UPC cost
  // map once (not once per sale), $0 for anything with no manifest at all
  // (items scanned outside manifest mode, per Cristian's instruction).
  const manifestIds = [...new Set(sales.map((s) => s.item.manifestId).filter((id): id is string => Boolean(id)))];
  const cogsMaps = new Map(await Promise.all(manifestIds.map(async (id) => [id, await cogsPerUnitByManifest(id)] as const)));

  let units = 0;
  let revenue = 0;
  let fees = 0;
  let shipping = 0;
  let cogs = 0;
  for (const sale of sales) {
    units += sale.quantity;
    revenue += Number(sale.revenue);
    fees += Number(sale.fees);
    shipping += Number(sale.shipping);
    const physicalUnits = sale.quantity * (sale.item.isMultipack && sale.item.packSize ? sale.item.packSize : 1);
    const cogsPerUnit =
      sale.item.manifestId && sale.item.upc ? (cogsMaps.get(sale.item.manifestId)?.get(sale.item.upc) ?? 0) : 0;
    cogs += cogsPerUnit * physicalUnits;
  }

  // Net refund cost = amount paid back to the buyer minus whatever fees
  // eBay credited back to us on that refund — the fee credit isn't pure
  // profit, it's an offset against the fees already subtracted above.
  let refunded = 0;
  let refundFeeCredit = 0;
  for (const refund of refunds) {
    refunded += Number(refund.amount);
    refundFeeCredit += Number(refund.feeCredit);
  }

  return {
    units,
    revenue,
    fees,
    shipping,
    refunded,
    profit: revenue - fees - shipping - cogs - (refunded - refundFeeCredit),
  };
}
