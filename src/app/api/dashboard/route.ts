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
    soldThisMonth,
    token,
  ] = await Promise.all([
    prisma.item.count({ where: { status: "pending_review" } }),
    prisma.item.count({ where: { status: "ready" } }),
    prisma.item.count({ where: { status: "listed" } }),
    prisma.item.findMany({
      where: { status: "listed", expirationDate: { not: null, lte: expiringCutoff } },
      orderBy: { expirationDate: "asc" },
      select: {
        id: true,
        finalTitle: true,
        sku: true,
        expirationDate: true,
        price: true,
        shelfLocation: true,
        ebayAdId: true,
        promotedBidPercentage: true,
        ebayPublishError: true,
        ebayPromoteError: true,
      },
    }),
    prisma.item.findMany({
      where: {
        status: { in: ["pending_review", "ready", "exported"] },
        expirationDate: { not: null, lte: expiringCutoff },
      },
      orderBy: { expirationDate: "asc" },
      select: { id: true, finalTitle: true, sku: true, expirationDate: true, status: true },
    }),
    prisma.ebayItemSale.aggregate({
      where: { soldAt: { gte: startOfMonth } },
      _sum: { revenue: true, quantity: true },
    }),
    prisma.ebayAuthToken.findUnique({ where: { environment: getEbayEnvironment() } }),
  ]);

  const missingScopes = token ? await getMissingScopes() : [];

  return NextResponse.json({
    stats: {
      pendingReview,
      readyToPublish,
      listed,
      expiringCount: expiringListed.length,
      soldThisMonthRevenue: Number(soldThisMonth._sum.revenue ?? 0),
      soldThisMonthUnits: soldThisMonth._sum.quantity ?? 0,
    },
    ebay: {
      connected: Boolean(token),
      missingScopes,
    },
    expiringListed: expiringListed.map((i) => ({ ...i, price: i.price != null ? Number(i.price) : null })),
    expiringUnlisted,
  });
}
