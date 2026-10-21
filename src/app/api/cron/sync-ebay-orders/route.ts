import { syncEbaySales } from "@/lib/channelSync";
import { settleOpenInvoices } from "@/lib/counterSale";
import { runShopifySync } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// Every 10 minutes (vercel.json), the safety net under eBay's instant sale
// alerts and Shopify's order webhooks: new eBay sales (quick mode, no
// shipping recheck; that's the 4-hourly full-sync's job), then every
// Shopify product's count and price checked against the app's, then up to
// 15 items that are live on eBay but not on Shopify yet, then any unpaid
// in-person invoice that's been paid since (counterSale.ts). Vercel sends
// `Authorization: Bearer $CRON_SECRET` automatically on requests it
// generates from that config; anything else is rejected.
export async function GET(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sales = await syncEbaySales("quick");
  const shopify = await runShopifySync({ items: "all", publish: { limit: 15 } });
  const invoices = await settleOpenInvoices().catch((e) => ({ checked: 0, sold: 0, errors: [String(e)] }));
  return NextResponse.json({ ...sales, shopifyAll: shopify, inPersonInvoices: invoices });
}
