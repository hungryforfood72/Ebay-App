import { syncEbayOrders, type EbayOrderSyncResult } from "@/lib/ebayOrderSync";
import { runShopifySync } from "@/lib/shopifySync";
import { withSyncLock } from "@/lib/syncLock";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 90;

// Manual trigger for the same sync the cron job runs every 10 minutes (see
// src/app/api/cron/sync-ebay-orders/route.ts) — for testing, or when
// Cristian doesn't want to wait for the next scheduled run. No CRON_SECRET
// needed here since this sits behind the site's normal password gate
// (src/proxy.ts), unlike the cron route which is deliberately exempted
// from that gate so Vercel's own request can reach it. Runs the full
// version (shipping recheck included), under the same lock as every other
// eBay sync, then reads new Shopify/Whatnot orders and brings Shopify's
// counts along for anything that sold.
//
// Optional { since: "ISO date" } body does a one-off historical catch-up
// instead of the normal incremental window — for sales that happened
// before this sync feature existed (e.g. on legacy CSV-uploaded listings
// linked up after the fact via /api/items/link-legacy). Optional
// { orderIds: [...] } re-checks specific orders the same way.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const since = body?.since ? new Date(body.since) : undefined;
  const orderIds = Array.isArray(body?.orderIds) ? body.orderIds.filter((id: unknown) => typeof id === "string") : [];
  let first = true;
  const locked = await withSyncLock("ebay-orders", "full", (mode) => {
    const options = first
      ? {
          ...(since && !isNaN(since.getTime()) ? { since } : {}),
          ...(orderIds.length > 0 ? { orderIds } : {}),
        }
      : {};
    first = false;
    return syncEbayOrders({ ...options, quick: mode !== "full" });
  });
  if (!locked.ran) {
    return NextResponse.json({
      ...emptyResult(),
      skipped: "A sync is already running. It will pick up anything new as soon as it finishes.",
    });
  }

  const result = locked.results[0];
  const changed = [...new Set(locked.results.flatMap((r) => r.changedItemIds))];
  const shopify = await runShopifySync({ items: changed });
  return NextResponse.json({
    ...result,
    shopifySalesRecorded: shopify.salesRecorded,
    errors: [...result.errors, ...shopify.errors.map((e) => `Shopify: ${e}`)],
  });
}

function emptyResult(): EbayOrderSyncResult {
  return {
    ordersScanned: 0,
    itemsUpdated: 0,
    itemsAlreadySynced: 0,
    itemsUnmatched: 0,
    refundsRecorded: 0,
    salesReversed: 0,
    listingsEnded: 0,
    soldOutLeftUp: [],
    changedItemIds: [],
    errors: [],
  };
}
