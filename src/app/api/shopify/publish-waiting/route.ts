import { ownerOnly } from "@/lib/auth";
import { runShopifySync } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// Settings' "Send to Shopify now": puts up to 40 waiting items on Shopify
// right away (failed ones included) instead of 15 per 10-minute cron run.
// Pressing it again does the next batch.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const result = await runShopifySync({ items: [], publish: { limit: 40, retryFailed: true } });
  return NextResponse.json(result);
}
