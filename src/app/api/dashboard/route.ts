import { cogsPerUnitByManifest } from "@/lib/cogs";
import { getEbayEnvironment, getLiveListingPrice, getMissingScopes } from "@/lib/ebay";
import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const maxDuration = 30;

const EXPIRING_WINDOW_DAYS = 21;

export async function GET(request: Request) {
  // Cristian's explicit instruction: employees see workflow counts
  // (pending review, ready to publish, listed, expiring) and nothing
  // about money — no revenue, fees, shipping cost, refunds, or profit.
  // The dollar figures are computed the same either way (the query cost
  // is the same regardless, and conditionally reshaping the Promise.all
  // below isn't worth the complexity) but stripped from the response
  // before it's ever sent to an employee's browser — never just hidden
  // client-side.
  const isOwner = getRequestUser(request)?.role === "owner";

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
    expiredNeedingPull,
    expiredEndFailed,
  ] = await Promise.all([
    prisma.item.count({ where: { status: "pending_review" } }),
    prisma.item.count({ where: { status: "ready" } }),
    prisma.item.count({ where: { status: "listed" } }),
    // "Actionable" = has a real live eBay listing, however it got there —
    // either published through this app's Inventory API flow (ebayOfferId)
    // or an older CSV-uploaded one since linked up via
    // /api/items/link-legacy (ebayListingId only). Excludes "sold" since a
    // fully sold-out item has nothing left to discount/promote, and
    // "expired" since the daily expiration sweep has already pulled that
    // one off eBay — it belongs in the shelf-pull list below, not here.
    prisma.item.findMany({
      where: {
        status: { notIn: ["sold", "expired"] },
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
        ebayMarkdownId: true,
        markdownPercentOff: true,
        markdownEndsAt: true,
        ebayMarkdownError: true,
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
    // Daily expiration sweep already ended these on eBay — now someone
    // needs to physically pull the shelf stock and acknowledge it. Visible
    // to both roles (no dollar fields here), unlike everything else this
    // route gates by isOwner.
    prisma.item.findMany({
      where: { status: "expired", shelfPullAcknowledgedAt: null },
      orderBy: { expiredAt: "asc" },
      select: { id: true, finalTitle: true, sku: true, shelfLocation: true, expirationDate: true, expiredAt: true },
    }),
    // Owner-only operational alert: the sweep tried and failed to end
    // these on eBay (still genuinely live, past their date) — needs
    // investigation, not a shelf-pull instruction, since nothing's
    // actually been removed yet.
    prisma.item.findMany({
      where: { status: { in: ["listed", "exported"] }, ebayEndError: { not: null } },
      orderBy: { expirationDate: "asc" },
      select: { id: true, finalTitle: true, sku: true, expirationDate: true, ebayEndError: true },
    }),
  ]);

  const missingScopes = token ? await getMissingScopes() : [];

  // The stored Item.price is only ever what it was set to at publish/
  // discount time — a running Sale event changes the real live price on
  // eBay directly, with no webhook back to this app, so the card would
  // otherwise silently show a stale pre-sale number while a sale is
  // active. Best-effort and parallel: a failed lookup for one item just
  // falls back to the stored price for that card, not a dashboard error.
  const livePrices = new Map(
    await Promise.all(
      expiringListed
        .filter((i) => i.ebayListingId)
        .map(async (i) => [i.id, await getLiveListingPrice(i.ebayListingId!)] as const)
    )
  );

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
    // Lets the page hide owner-only controls (discount/promote/sale on the
    // expiring cards) without a second request — the routes behind those
    // controls enforce owner-only themselves regardless.
    isOwner,
    stats: {
      pendingReview,
      readyToPublish,
      listed,
      expiringCount: expiringListed.length,
      soldThisMonthUnits,
      // Dollar figures only for the owner — see the isOwner comment above.
      ...(isOwner
        ? {
            soldThisMonthRevenue,
            soldThisMonthFees,
            soldThisMonthShipping,
            soldThisMonthRefunded: refundedThisMonthAmount,
            soldThisMonthProfit,
          }
        : {}),
    },
    ebay: {
      connected: Boolean(token),
      missingScopes,
    },
    expiringListed: expiringListed.map((i) => {
      const live = livePrices.get(i.id);
      return {
        ...i,
        price: i.price != null ? Number(i.price) : null,
        livePrice: live?.price ?? null,
        liveOriginalPrice: live?.originalPrice ?? null,
      };
    }),
    expiringUnlisted,
    expiredNeedingPull,
    ...(isOwner ? { expiredEndFailed } : {}),
  });
}
