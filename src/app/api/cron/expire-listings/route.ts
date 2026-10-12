import { expireDueListings } from "@/lib/expireListings";
import { sendNewDealsAlert, sendPastDateAlert } from "@/lib/dealAlerts";
import { runShopifySync } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// Vercel Cron is UTC-only with no timezone/DST awareness, and a fixed UTC
// offset would drift an hour twice a year — so this fires hourly (see
// vercel.json) and checks the real Chicago wall-clock hour itself instead
// of trusting the schedule string to mean 8PM Central. Correct across DST
// with no maintenance, and safe to no-op every other hour.
function chicagoHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(now));
}

// Triggered by Vercel Cron (see vercel.json) — same
// `Authorization: Bearer $CRON_SECRET` check as
// src/app/api/cron/sync-ebay-orders/route.ts.
export async function GET(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const hour = chicagoHour(now);

  // 6 PM Chicago: the daily "new steals just dropped" deal alert.
  if (hour === 18) {
    try {
      return NextResponse.json({ newDealsAlert: await sendNewDealsAlert(now) });
    } catch (e) {
      console.error("[cron] new deals alert failed", e);
      return NextResponse.json({ error: "New deals alert failed." }, { status: 500 });
    }
  }
  if (hour !== 20) {
    return NextResponse.json({ skipped: "Not the 8PM Chicago hour yet." });
  }

  const result = await expireDueListings(now);
  // Off Whatnot, onto the past-date page (or off the store) right away
  // rather than at the next 10-minute sync.
  const shopify = result.changedItemIds.length > 0 ? await runShopifySync({ items: result.changedItemIds }) : null;
  // Then tell deal-alert subscribers, once the items are on the page.
  let pastDateAlert = null;
  try {
    pastDateAlert = await sendPastDateAlert(result.pastDated);
  } catch (e) {
    console.error("[cron] past-date alert failed", e);
  }
  return NextResponse.json({ ...result, shopify, pastDateAlert });
}
