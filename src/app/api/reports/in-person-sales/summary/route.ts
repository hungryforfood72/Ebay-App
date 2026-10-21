import { requireOwner } from "@/lib/auth";
import { counterSaleError } from "@/lib/counterSale";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// The dashboard's In-person sales card: quick counts only (the full page
// is /api/reports/in-person-sales). Owner only.
export async function GET(request: NextRequest) {
  try {
    requireOwner(request);
    const startOfDay = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
    startOfDay.setHours(0, 0, 0, 0);
    // That's Chicago midnight in the server's clock; shift it back to real time.
    const offset = new Date().getTime() - new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })).getTime();
    const since = new Date(startOfDay.getTime() + offset);
    const [today, toReview, unpaid] = await Promise.all([
      prisma.counterSale.findMany({ where: { status: "sold", completedAt: { gte: since } }, select: { quantity: true, pricePerUnit: true } }),
      prisma.counterSale.count({
        where: { reviewedAt: null, OR: [{ nearExpiry: true }, { belowAsked: true }, { status: "failed" }], NOT: { status: "cancelled" } },
      }),
      prisma.counterSale.count({ where: { status: "awaiting_payment" } }),
    ]);
    return NextResponse.json({
      todaySales: today.length,
      todayRevenue: Math.round(today.reduce((s, r) => s + Number(r.pricePerUnit) * r.quantity, 0) * 100) / 100,
      toReview,
      unpaid,
    });
  } catch (e) {
    return counterSaleError(e);
  }
}
