import { expireDueListings } from "@/lib/expireListings";
import { runShopifySync } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// Vercel Cron is UTC-only with no timezone/DST awareness, and a fixed UTC
// offset would drift an hour twice a year — so this fires hourly (see
// vercel.json) and checks the real Chicago wall-clock hour itself instead
// of trusting the schedule string to mean 8PM Central. Correct across DST
// with no maintenance, and safe to no-op every other hour.
function isChicago8PMHour(now: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(now)
  );
  return hour === 20;
}

// Triggered by Vercel Cron (see vercel.json) — same
// `Authorization: Bearer $CRON_SECRET` check as
// src/app/api/cron/sync-ebay-orders/route.ts.
export async function GET(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  if (!isChicago8PMHour(now)) {
    return NextResponse.json({ skipped: "Not the 8PM Chicago hour yet." });
  }

  const result = await expireDueListings(now);
  // Off Whatnot, onto the past-date page (or off the store) right away
  // rather than at the next 10-minute sync.
  const shopify = result.changedItemIds.length > 0 ? await runShopifySync({ items: result.changedItemIds }) : null;
  return NextResponse.json({ ...result, shopify });
}
