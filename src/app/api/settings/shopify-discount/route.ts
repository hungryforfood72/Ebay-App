import { ownerOnly } from "@/lib/auth";
import { getShopifyPricing, setShopifyPricing, type ShopifyPricing } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  return NextResponse.json({ pricing: await getShopifyPricing() });
}

// Existing Shopify prices follow on the next 10-minute sync, which fixes
// any price that doesn't match.
export async function PUT(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const pricing: ShopifyPricing = {
    ebayPct: Number(body.pricing?.ebayPct),
    retailPct: Number(body.pricing?.retailPct),
    noRetailPct: Number(body.pricing?.noRetailPct),
  };
  if (Object.values(pricing).some((pct) => !Number.isFinite(pct) || pct < 0 || pct >= 100)) {
    return NextResponse.json({ error: "Enter each percent from 0 up to (not including) 100." }, { status: 400 });
  }
  await setShopifyPricing(pricing);
  return NextResponse.json({ pricing });
}
