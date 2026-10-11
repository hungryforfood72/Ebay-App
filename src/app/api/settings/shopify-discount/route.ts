import { ownerOnly } from "@/lib/auth";
import { getShopifyDiscountPct, setShopifyDiscountPct } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  return NextResponse.json({ discountPct: await getShopifyDiscountPct() });
}

// Existing Shopify prices follow on the next 10-minute sync, which fixes
// any price that doesn't match.
export async function PUT(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const pct = Number(body.discountPct);
  if (!Number.isFinite(pct) || pct < 0 || pct >= 100) {
    return NextResponse.json({ error: "Enter a percent from 0 up to (not including) 100." }, { status: 400 });
  }
  await setShopifyDiscountPct(pct);
  return NextResponse.json({ discountPct: pct });
}
