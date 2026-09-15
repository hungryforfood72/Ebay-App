import { syncEbayOrders } from "@/lib/ebayOrderSync";
import { NextResponse } from "next/server";

export const maxDuration = 60;

// Manual trigger for the same sync the cron job runs every 4 hours (see
// src/app/api/cron/sync-ebay-orders/route.ts) — for testing, or when
// Cristian doesn't want to wait for the next scheduled run. No CRON_SECRET
// needed here since this sits behind the site's normal password gate
// (src/proxy.ts), unlike the cron route which is deliberately exempted
// from that gate so Vercel's own request can reach it.
export async function POST() {
  const result = await syncEbayOrders();
  return NextResponse.json(result);
}
