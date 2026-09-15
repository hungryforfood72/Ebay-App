import { cogsPerUnitByManifest } from "@/lib/cogs";
import { getEbayEnvironment, getMissingScopes } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

const EXPIRING_WINDOW_DAYS = 21;

export async function GET() {
  const expiringCutoff = new Date(Date.now() + EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [
    pendingReview,
    readyToPublish,
    listed,
    expiringListed,
    expiringUnlisted,
    salesThisMonth,
    token,
    refundsThisMonth,
  ] = await Promise.all([
    prisma.item.count({ where: { status: "pending_review" } }),
    prisma.item.count({ where: { status: "ready" } }),
    prisma.item.count({ where: { status: "listed" } }),
    // "Actionable" = has a real live eBay listing, however it got there —
    // either published through this app's Inventory API flow (ebayOfferId)
    // or an older CSV-uploaded one since linked up via
    // /api/items/link-legacy (ebayListingId only). Excludes "sold" since a
    // fully sold-out item has nothing left to discount/promote.
    prisma.item.findMany({
      where: {
        status: { not: "sold" },
        OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }],
        expirationDate: { not: null, lte: expiringCutoff },
      },
      orderBy: { expirationDate: "asc" },
      select: {
        id: true,
        finalTitle: true,
        sku: true,
        expirationDate: true,
        price: true,
        shelfLocation: true,
        ebayListingId: true,
        ebayEnvironment: true,
        ebayAdId: true,
        promotedBidPercentage: true,
        ebayPublishError: true,
        ebayPromoteError: true,
      },
    }),
    prisma.item.findMany({
      where: {
        status: { in: ["pending_review", "ready", "exported"] },
        ebayOfferId: null,
        ebayListingId: null,
        expirationDate: { not: null, lte: expiringCutoff },
      },
      orderBy: { expirationDate: "asc" },
      select: { id: true, finalTitle: true, sku: true, expirationDate: true, status: true },
    }),
    // Full rows, not an aggregate — computing profit needs each sale's item
    // (for manifestId/upc/multipack) to look up COGS, which a plain _sum
    // can't give us.
    prisma.ebayItemSale.findMany({
      where: { soldAt: { gte: startOfMonth } },
      select: {
        quantity: true,
        revenue: true,
        fees: true,
        shipping: true,
        item: { select: { manifestId: true, upc: true, isMultipack: true, packSize: true } },
      },
    }),
    prisma.ebayAuthToken.findUnique({ where: { environment: getEbayEnvironment() } }),
    // Refunds this month, scoped by when the refund itself posted (not the
    // original sale date) — a September refund on an August sale belongs in
    // September's numbers. EbayItemRefund can only ever exist attached to
    // an EbayItemSale, so this is automatically already scoped to
    // app-tracked listings only, same as sales.
    prisma.ebayItemRefund.findMany({
      where: { refundedAt: { gte: startOfMonth } },
      select: { amount: true, feeCredit: true },
    }),
  ]);

  const missingScopes = token ? await getMissingScopes() : [];

  // COGS is manifest-derived — fetch each distinct manifest's per-UPC cost
  // map once (not once per sale), $0 for anything with no manifest at all
  // (items scanned outside manifest mode, per Cristian's instruction).
  const manifestIds = [...new Set(salesThisMonth.map((s) => s.item.manifestId).filter((id): id is string => Boolean(id)))];
  const cogsMaps = new Map(await Promise.all(manifestIds.map(async (id) => [id, await cogsPerUnitByManifest(id)] as const)));

  let soldThisMonthRevenue = 0;
  let soldThisMonthFees = 0;
  let soldThisMonthShipping = 0;
  let soldThisMonthCogs = 0;
  let soldThisMonthUnits = 0;
  for (const sale of salesThisMonth) {
    soldThisMonthRevenue += Number(sale.revenue);
    soldThisMonthFees += Number(sale.fees);
    soldThisMonthShipping += Number(sale.shipping);
    soldThisMonthUnits += sale.quantity;

    const physicalUnits = sale.quantity * (sale.item.isMultipack && sale.item.packSize ? sale.item.packSize : 1);
    const cogsPerUnit =
      sale.item.manifestId && sale.item.upc ? (cogsMaps.get(sale.item.manifestId)?.get(sale.item.upc) ?? 0) : 0;
    soldThisMonthCogs += cogsPerUnit * physicalUnits;
  }
  // Net refund cost = amount paid back to the buyer minus whatever fees
  // eBay credited back to us on that refund — the fee credit isn't pure
  // profit, it's an offset against the fees already subtracted above.
  let refundedThisMonthAmount = 0;
  let refundedThisMonthFeeCredit = 0;
  for (const refund of refundsThisMonth) {
    refundedThisMonthAmount += Number(refund.amount);
    refundedThisMonthFeeCredit += Number(refund.feeCredit);
  }
  const refundedThisMonthNet = refundedThisMonthAmount - refundedThisMonthFeeCredit;

  const soldThisMonthProfit =
    soldThisMonthRevenue - soldThisMonthFees - soldThisMonthShipping - soldThisMonthCogs - refundedThisMonthNet;

  return NextResponse.json({
    stats: {
      pendingReview,
      readyToPublish,
      listed,
      expiringCount: expiringListed.length,
      soldThisMonthRevenue,
      soldThisMonthUnits,
      soldThisMonthFees,
      soldThisMonthShipping,
      soldThisMonthRefunded: refundedThisMonthAmount,
      soldThisMonthProfit,
    },
    ebay: {
      connected: Boolean(token),
      missingScopes,
    },
    expiringListed: expiringListed.map((i) => ({ ...i, price: i.price != null ? Number(i.price) : null })),
    expiringUnlisted,
  });
}
