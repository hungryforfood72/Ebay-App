import { getEbayEnvironment, getLiveListingPrice, getMissingScopes } from "@/lib/ebay";
import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getItemLocations } from "@/lib/warehouse/bins";
import { NextResponse } from "next/server";

export const maxDuration = 30;

const EXPIRING_WINDOW_DAYS = 21;

export async function GET(request: Request) {
  // Cristian's explicit instruction: employees see nothing about money or
  // sales, and of the inventory counts only "expiring soon" (2026-10-29:
  // pending review / ready to publish / listed are manager numbers).
  // Sales figures live in /api/dashboard/sales, which is owner-only.
  const isOwner = getRequestUser(request)?.role === "owner";

  const expiringCutoff = new Date(Date.now() + EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [
    pendingReview,
    readyToPublish,
    listed,
    expiringListed,
    expiringUnlisted,
    token,
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
        // Already off eBay and on the Shopify past-date page.
        pastDateAt: null,
      },
      orderBy: { expirationDate: "asc" },
      select: {
        id: true,
        finalTitle: true,
        sku: true,
        expirationDate: true,
        price: true,
        originalPrice: true,
        shelfLocation: true,
        ebayListingId: true,
        ebayEnvironment: true,
        ebayAdId: true,
        promotedBidPercentage: true,
        ebayPublishError: true,
        ebayPromoteError: true,
        ebayMarkdownId: true,
        markdownPercentOff: true,
        markdownStartedAt: true,
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
    prisma.ebayAuthToken.findUnique({ where: { environment: getEbayEnvironment() } }),
    // Daily expiration sweep already ended these on eBay — now someone
    // needs to physically pull the shelf stock and acknowledge it. Visible
    // to both roles (no dollar fields here), unlike everything else this
    // route gates by isOwner.
    prisma.item.findMany({
      where: { status: "expired", shelfPullAcknowledgedAt: null },
      orderBy: { expiredAt: "asc" },
      select: { id: true, finalTitle: true, sku: true, shelfLocation: true, expirationDate: true, expiredAt: true, expirySplit: true, pullReason: true },
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

  // Where to find each one: its bins (warehouse mode), or the old shelf
  // for items listed before that. The pull cards use it to say which
  // bins to empty.
  const locations = await getItemLocations([...expiringListed, ...expiredNeedingPull]);

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

  return NextResponse.json({
    // Lets the page hide owner-only controls (discount/promote/sale on the
    // expiring cards) without a second request — the routes behind those
    // controls enforce owner-only themselves regardless.
    isOwner,
    stats: isOwner
      ? { pendingReview, readyToPublish, listed, expiringCount: expiringListed.length }
      : { expiringCount: expiringListed.length },
    ebay: {
      connected: Boolean(token),
      missingScopes,
    },
    expiringListed: expiringListed.map((i) => {
      const live = livePrices.get(i.id);
      return {
        ...i,
        price: i.price != null ? Number(i.price) : null,
        originalPrice: i.originalPrice != null ? Number(i.originalPrice) : null,
        livePrice: live?.price ?? null,
        liveOriginalPrice: live?.originalPrice ?? null,
        location: locations.get(i.id) ?? null,
      };
    }),
    expiringUnlisted,
    expiredNeedingPull: expiredNeedingPull.map((i) => ({ ...i, location: locations.get(i.id) ?? null })),
    ...(isOwner ? { expiredEndFailed } : {}),
  });
}
