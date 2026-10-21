import { prisma } from "./prisma";
import { settleOpenInvoices } from "./counterSale";

// The owner's In-person sales page (/reports/in-person): every walk-up and
// shelf sale, who made it from which scanner login, the price against the
// ideal, and the proof photos + reason when one was flagged (see
// counterSale.ts). Sales made before the checks existed (2026-10-21) show
// too, from the plain InPersonSale / ManifestWalkupSale records, marked
// legacy: no ideal price, photos or payment on those.

export type InPersonRow = {
  id: string;
  legacy: boolean;
  soldAt: string;
  kind: "walkup" | "shelf" | null;
  description: string;
  quantity: number;
  packSize: number | null;
  pricePerUnit: number;
  total: number;
  idealPricePerUnit: number | null;
  allowedPricePerUnit: number | null;
  nearExpiry: boolean;
  belowAsked: boolean;
  reason: string | null;
  photoUrls: string[];
  payment: "cash" | "invoice" | null;
  status: string;
  customerEmail: string | null;
  shopifyOrderName: string | null;
  soldBy: string | null;
  error: string | null;
  // Flagged (expiring soon or under price) and nobody has looked yet.
  needsReview: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  manifestId: string | null;
};

export type SellerSummary = { soldBy: string; sales: number; revenue: number; flagged: number; underBy: number };

export type InPersonReport = {
  rows: InPersonRow[];
  totals: { sales: number; revenue: number; needsReview: number; unpaid: number; underBy: number };
  sellers: SellerSummary[];
  settled: { checked: number; sold: number; errors: string[] };
};

const n = (v: unknown) => (v == null ? null : Number(v));

export async function getInPersonReport(days: number): Promise<InPersonReport> {
  // Paid invoices get recorded before the page shows them as unpaid.
  const settled = await settleOpenInvoices().catch((e) => ({ checked: 0, sold: 0, errors: [String(e)] }));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [sales, linked] = await Promise.all([
    prisma.counterSale.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "desc" } }),
    // Every link, not just this window's: an invoice made last month and
    // paid today points at today's stock record.
    prisma.counterSale.findMany({
      where: { OR: [{ inPersonSaleId: { not: null } }, { walkupSaleId: { not: null } }] },
      select: { inPersonSaleId: true, walkupSaleId: true },
    }),
  ]);
  const linkedInPerson = linked.map((l) => l.inPersonSaleId).filter((x): x is string => Boolean(x));
  const linkedWalkup = linked.map((l) => l.walkupSaleId).filter((x): x is string => Boolean(x));

  const [inPerson, walkups] = await Promise.all([
    prisma.inPersonSale.findMany({
      where: { soldAt: { gte: since }, id: { notIn: linkedInPerson } },
      include: { item: { select: { finalTitle: true, aiTitle: true, manifestId: true, isMultipack: true, packSize: true } } },
    }),
    prisma.manifestWalkupSale.findMany({ where: { createdAt: { gte: since }, id: { notIn: linkedWalkup } } }),
  ]);
  const walkupLines = walkups.length
    ? await prisma.manifestLine.findMany({
        where: { OR: walkups.map((w) => ({ manifestId: w.manifestId, upc: w.upc })) },
        select: { manifestId: true, upc: true, description: true },
      })
    : [];

  const rows: InPersonRow[] = [
    ...sales.map((s) => {
      const flagged = s.nearExpiry || s.belowAsked;
      return {
        id: s.id,
        legacy: false,
        soldAt: (s.completedAt ?? s.createdAt).toISOString(),
        kind: s.kind as "walkup" | "shelf",
        description: s.description,
        quantity: s.quantity,
        packSize: s.packSize,
        pricePerUnit: Number(s.pricePerUnit),
        total: Math.round(Number(s.pricePerUnit) * s.quantity * 100) / 100,
        idealPricePerUnit: n(s.idealPricePerUnit),
        allowedPricePerUnit: n(s.allowedPricePerUnit),
        nearExpiry: s.nearExpiry,
        belowAsked: s.belowAsked,
        reason: s.reason,
        photoUrls: s.photoUrls,
        payment: s.payment as "cash" | "invoice",
        status: s.status,
        customerEmail: s.customerEmail,
        shopifyOrderName: s.shopifyOrderName,
        soldBy: s.soldBy,
        error: s.error,
        needsReview: (flagged || s.status === "failed") && !s.reviewedAt,
        reviewedAt: s.reviewedAt?.toISOString() ?? null,
        reviewedBy: s.reviewedBy,
        manifestId: s.manifestId,
      };
    }),
    ...inPerson.map((s) => ({
      id: `ips:${s.id}`,
      legacy: true,
      soldAt: s.soldAt.toISOString(),
      kind: null,
      description: s.item.finalTitle ?? s.item.aiTitle ?? "Item",
      quantity: s.quantity,
      packSize: s.item.isMultipack && s.item.packSize && s.item.packSize > 1 ? s.item.packSize : null,
      pricePerUnit: Number(s.pricePerUnit),
      total: Number(s.revenue),
      idealPricePerUnit: null,
      allowedPricePerUnit: null,
      nearExpiry: false,
      belowAsked: false,
      reason: null,
      photoUrls: [],
      payment: null,
      status: "sold",
      customerEmail: null,
      shopifyOrderName: null,
      soldBy: s.recordedBy,
      error: null,
      needsReview: false,
      reviewedAt: null,
      reviewedBy: null,
      manifestId: s.item.manifestId,
    })),
    ...walkups.map((w) => ({
      id: `mws:${w.id}`,
      legacy: true,
      soldAt: w.createdAt.toISOString(),
      kind: "walkup" as const,
      description: walkupLines.find((l) => l.manifestId === w.manifestId && l.upc === w.upc)?.description ?? `UPC ${w.upc}`,
      quantity: w.quantity,
      packSize: null,
      pricePerUnit: Number(w.pricePerUnit),
      total: Math.round(Number(w.pricePerUnit) * w.quantity * 100) / 100,
      idealPricePerUnit: null,
      allowedPricePerUnit: null,
      nearExpiry: false,
      belowAsked: false,
      reason: null,
      photoUrls: [],
      payment: null,
      status: "sold",
      customerEmail: null,
      shopifyOrderName: null,
      soldBy: w.recordedBy,
      error: null,
      needsReview: false,
      reviewedAt: null,
      reviewedBy: null,
      manifestId: w.manifestId,
    })),
  ].sort((a, b) => b.soldAt.localeCompare(a.soldAt));

  const sold = rows.filter((r) => r.status === "sold");
  // How much under the ideal price, in dollars, across the sale.
  const underBy = (r: InPersonRow) =>
    r.idealPricePerUnit != null ? Math.max(0, (r.idealPricePerUnit - r.pricePerUnit) * r.quantity) : 0;
  const bySeller = new Map<string, SellerSummary>();
  for (const r of sold) {
    const key = r.soldBy ?? "Unknown";
    const s = bySeller.get(key) ?? { soldBy: key, sales: 0, revenue: 0, flagged: 0, underBy: 0 };
    s.sales++;
    s.revenue += r.total;
    if (r.nearExpiry || r.belowAsked) s.flagged++;
    s.underBy += underBy(r);
    bySeller.set(key, s);
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    rows,
    totals: {
      sales: sold.length,
      revenue: round(sold.reduce((sum, r) => sum + r.total, 0)),
      needsReview: rows.filter((r) => r.needsReview).length,
      unpaid: rows.filter((r) => r.status === "awaiting_payment").length,
      underBy: round(sold.reduce((sum, r) => sum + underBy(r), 0)),
    },
    sellers: [...bySeller.values()]
      .map((s) => ({ ...s, revenue: round(s.revenue), underBy: round(s.underBy) }))
      .sort((a, b) => b.revenue - a.revenue),
    settled,
  };
}

export async function setReviewed(id: string, reviewed: boolean, by: string) {
  return prisma.counterSale.update({
    where: { id },
    data: reviewed ? { reviewedAt: new Date(), reviewedBy: by } : { reviewedAt: null, reviewedBy: null },
    select: { id: true, reviewedAt: true, reviewedBy: true },
  });
}
