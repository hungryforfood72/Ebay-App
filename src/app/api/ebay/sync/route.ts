import { syncEbayOrders } from "@/lib/ebayOrderSync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 90;

// Manual trigger for the same sync the cron job runs every 4 hours (see
// src/app/api/cron/sync-ebay-orders/route.ts) — for testing, or when
// Cristian doesn't want to wait for the next scheduled run. No CRON_SECRET
// needed here since this sits behind the site's normal password gate
// (src/proxy.ts), unlike the cron route which is deliberately exempted
// from that gate so Vercel's own request can reach it.
//
// Optional { since: "ISO date" } body does a one-off historical catch-up
// instead of the normal incremental window — for sales that happened
// before this sync feature existed (e.g. on legacy CSV-uploaded listings
// linked up after the fact via /api/items/link-legacy).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const since = body?.since ? new Date(body.since) : undefined;
  const result = await syncEbayOrders(since && !isNaN(since.getTime()) ? { since } : undefined);
  return NextResponse.json(result);
}
