import { cogsMapsFor, costPerListingUnit } from "./cogs";
import { getConsignmentLedger } from "./consignmentLedger";
import { prisma } from "./prisma";

export type SalesSummary = {
  units: number;
  revenue: number;
  fees: number;
  shipping: number;
  cogs: number;
  refunded: number;
  // Consignment suppliers' share of the profit on sales in the range: what
  // those loads cost instead of COGS (they're $0 COGS, nothing was paid).
  supplierShare: number;
  profit: number;
  // Revenue split by where it sold: "ebay", "shopify", "whatnot", ...
  revenueByChannel: Record<string, number>;
};

// Sales, refunds and profit for app-tracked eBay, Shopify, Whatnot and
// in-person (shelf/walk-up, cash) sales in [from, to) —
// either bound null for open-ended. Sales are scoped by when they sold,
// refunds by when the refund itself posted (not the original sale date): a
// September refund on an August sale belongs in September's numbers.
// EbayItemRefund can only exist attached to an EbayItemSale, so both are
// automatically scoped to app-tracked listings only. Shopify sales carry
// no shipping cost: the buyer pays for the label there. In-person sales
// carry no fees and no shipping.
export async function salesSummary(from: Date | null, to: Date | null): Promise<SalesSummary> {
  const range = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } : undefined;

  const itemSelect = {
    manifestId: true,
    upc: true,
    isMultipack: true,
    packSize: true,
    isBundle: true,
    bundleComponents: true,
  } as const;
  const [sales, refunds, shopifySales, shopifyRefunds, inPersonSales, manifestWalkups] = await Promise.all([
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
        item: { select: itemSelect },
      },
    }),
    prisma.ebayItemRefund.findMany({
      where: { refundedAt: range },
      select: { amount: true, feeCredit: true },
    }),
    prisma.shopifySale.findMany({
      where: { soldAt: range },
      select: { quantity: true, revenue: true, fees: true, channel: true, item: { select: itemSelect } },
    }),
    prisma.shopifyRefund.findMany({ where: { refundedAt: range }, select: { amount: true } }),
    prisma.inPersonSale.findMany({
      where: { soldAt: range },
      select: { quantity: true, revenue: true, item: { select: itemSelect } },
    }),
    // Sold straight off a manifest without ever being scanned in, so there's
    // no Item: costed as one plain unit of that manifest's UPC.
    prisma.manifestWalkupSale.findMany({
      where: { createdAt: range },
      select: { manifestId: true, upc: true, quantity: true, pricePerUnit: true },
    }),
  ]);
  const inPerson = [
    ...inPersonSales,
    ...manifestWalkups.map((w) => ({
      quantity: w.quantity,
      revenue: Number(w.pricePerUnit) * w.quantity,
      item: { manifestId: w.manifestId, upc: w.upc, isMultipack: false, packSize: null, isBundle: false, bundleComponents: null },
    })),
  ].map((s) => ({ ...s, fees: 0, channel: "in_person" }));

  // COGS is manifest-derived, $0 for anything with no manifest at all
  // (items scanned outside manifest mode, per Cristian's instruction).
  const cogsMaps = await cogsMapsFor([...sales, ...shopifySales, ...inPerson].map((s) => s.item.manifestId));

  let units = 0;
  let revenue = 0;
  let fees = 0;
  let shipping = 0;
  let cogs = 0;
  const revenueByChannel: Record<string, number> = {};
  for (const sale of [...sales.map((s) => ({ ...s, channel: "ebay" })), ...shopifySales, ...inPerson]) {
    units += sale.quantity;
    revenue += Number(sale.revenue);
    fees += Number(sale.fees);
    if ("shipping" in sale) shipping += Number(sale.shipping);
    revenueByChannel[sale.channel] = (revenueByChannel[sale.channel] ?? 0) + Number(sale.revenue);
    // Per listing unit (a pack, a bundle) — sale.quantity is on that scale.
    cogs += costPerListingUnit(sale.item, cogsMaps).cost * sale.quantity;
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
  // Shopify Payments keeps its fee on a refund, so there's no credit.
  for (const refund of shopifyRefunds) refunded += Number(refund.amount);

  // Consignment loads (Cristian, 2026-10-24): the supplier's share of each
  // sale in the range, per sale from the same ledger the manifest page
  // shows, so the dashboard's profit is what's really left.
  const manifestIds = [
    ...new Set([...sales, ...shopifySales, ...inPerson].map((s) => s.item.manifestId).filter((id): id is string => Boolean(id))),
  ];
  const consignmentIds = manifestIds.length
    ? (await prisma.manifest.findMany({ where: { id: { in: manifestIds }, consignment: true }, select: { id: true } })).map((m) => m.id)
    : [];
  let supplierShare = 0;
  for (const id of consignmentIds) {
    const ledger = await getConsignmentLedger(id);
    for (const sale of ledger?.sales ?? []) {
      if ((from && sale.soldAt < from) || (to && sale.soldAt >= to)) continue;
      supplierShare += sale.supplierShare;
    }
  }

  return {
    units,
    revenue,
    fees,
    shipping,
    cogs,
    refunded,
    supplierShare,
    profit: revenue - fees - shipping - cogs - (refunded - refundFeeCredit) - supplierShare,
    revenueByChannel,
  };
}
