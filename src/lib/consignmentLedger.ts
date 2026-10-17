import { DEFAULT_CONSIGNMENT_SUPPLIER_PCT } from "./consignment";
import { prisma } from "./prisma";

// ---------------------------------------------------------------------------
// What we owe a consignment supplier (Manifest.consignment), Cristian
// 2026-10-17. The deal: the supplier gets consignmentSupplierPct of the
// profit after eBay fees and the shipping label, paid as things sell.
//
// Worked out live from every sale of this manifest's stock, so a refund or
// a late-arriving label cost changes it on the next load:
//   eBay:      revenue - fees - label - (refund - fee credit)
//   Shopify / Whatnot: revenue - fees - refunds (buyer paid shipping)
//   in person / walk-up: the sale price
// A sale that lost money owes the supplier nothing (his share of a loss
// isn't taken back off other sales). Payments recorded in
// ConsignmentPayment come off the total.
// ---------------------------------------------------------------------------

export type ConsignmentSale = {
  id: string;
  // Which product it was (the item's scanned UPC, or the walk-up's), for
  // the supplier's per-product view.
  upc: string | null;
  soldAt: Date;
  channel: string;
  title: string;
  units: number;
  revenue: number;
  costs: number;
  profit: number;
  supplierShare: number;
  // eBay sales still waiting on their label cost (labels post in batches),
  // so the share may come down a little once it does.
  labelPending: boolean;
};

export type ConsignmentLedger = {
  supplierPct: number;
  sales: ConsignmentSale[];
  earned: number;
  paid: number;
  balance: number;
  payments: { id: string; amount: number; paidAt: Date; note: string | null; recordedBy: string | null }[];
};

const round = (n: number) => Math.round(n * 100) / 100;

export async function getConsignmentLedger(manifestId: string): Promise<ConsignmentLedger | null> {
  const manifest = await prisma.manifest.findUnique({
    where: { id: manifestId },
    select: {
      consignment: true,
      consignmentSupplierPct: true,
      consignmentPayments: { orderBy: { paidAt: "desc" } },
      walkupSales: true,
      lines: { select: { upc: true, description: true } },
      items: {
        select: {
          id: true,
          upc: true,
          finalTitle: true,
          aiTitle: true,
          sales: { include: { refunds: true } },
          shopifySales: { include: { refunds: true } },
          inPersonSales: true,
        },
      },
    },
  });
  if (!manifest?.consignment) return null;
  const supplierPct = manifest.consignmentSupplierPct ?? DEFAULT_CONSIGNMENT_SUPPLIER_PCT;
  const share = (profit: number) => round(Math.max(0, profit) * (supplierPct / 100));

  const sales: ConsignmentSale[] = [];
  for (const item of manifest.items) {
    const title = item.finalTitle ?? item.aiTitle ?? "Untitled item";
    for (const s of item.sales) {
      const refunds = s.refunds.reduce((sum, r) => sum + Number(r.amount) - Number(r.feeCredit), 0);
      const costs = Number(s.fees) + Number(s.shipping) + refunds;
      const profit = Number(s.revenue) - costs;
      sales.push({
        id: s.id,
        upc: item.upc,
        soldAt: s.soldAt,
        channel: "eBay",
        title,
        units: s.quantity,
        revenue: Number(s.revenue),
        costs: round(costs),
        profit: round(profit),
        supplierShare: share(profit),
        labelPending: Number(s.shipping) === 0,
      });
    }
    for (const s of item.shopifySales) {
      const refunds = s.refunds.reduce((sum, r) => sum + Number(r.amount), 0);
      const costs = Number(s.fees) + refunds;
      const profit = Number(s.revenue) - costs;
      sales.push({
        id: s.id,
        upc: item.upc,
        soldAt: s.soldAt,
        channel: s.channel === "whatnot" ? "Whatnot" : "Shopify",
        title,
        units: s.quantity,
        revenue: Number(s.revenue),
        costs: round(costs),
        profit: round(profit),
        supplierShare: share(profit),
        labelPending: false,
      });
    }
    for (const s of item.inPersonSales) {
      sales.push({
        id: s.id,
        upc: item.upc,
        soldAt: s.soldAt,
        channel: "In person",
        title,
        units: s.quantity,
        revenue: Number(s.revenue),
        costs: 0,
        profit: Number(s.revenue),
        supplierShare: share(Number(s.revenue)),
        labelPending: false,
      });
    }
  }
  for (const w of manifest.walkupSales) {
    const revenue = w.quantity * Number(w.pricePerUnit);
    sales.push({
      id: w.id,
      upc: w.upc,
      soldAt: w.createdAt,
      channel: "Walk-up",
      title: manifest.lines.find((l) => l.upc === w.upc)?.description ?? w.note ?? `UPC ${w.upc}`,
      units: w.quantity,
      revenue,
      costs: 0,
      profit: round(revenue),
      supplierShare: share(revenue),
      labelPending: false,
    });
  }
  sales.sort((a, b) => b.soldAt.getTime() - a.soldAt.getTime());

  const earned = round(sales.reduce((sum, s) => sum + s.supplierShare, 0));
  const payments = manifest.consignmentPayments.map((p) => ({
    id: p.id,
    amount: Number(p.amount),
    paidAt: p.paidAt,
    note: p.note,
    recordedBy: p.recordedBy,
  }));
  const paid = round(payments.reduce((sum, p) => sum + p.amount, 0));
  return { supplierPct, sales, earned, paid, balance: round(earned - paid), payments };
}
