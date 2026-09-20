import { getWalkupSaleSettings, setWalkupSaleSettings } from "@/lib/walkupSale";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const settings = await getWalkupSaleSettings();
  return NextResponse.json(settings);
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const floorMarginPct = Number(body.floorMarginPct);
  const idealRetailPct = Number(body.idealRetailPct);
  const nearExpiryRetailPct = Number(body.nearExpiryRetailPct);

  for (const [label, value] of [
    ["Floor margin", floorMarginPct],
    ["Ideal price", idealRetailPct],
    ["Near-expiry price", nearExpiryRetailPct],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value > 500) {
      return NextResponse.json({ error: `${label} must be a positive number.` }, { status: 400 });
    }
  }

  await setWalkupSaleSettings({ floorMarginPct, idealRetailPct, nearExpiryRetailPct });
  return NextResponse.json({ floorMarginPct, idealRetailPct, nearExpiryRetailPct });
}
