import { getUnprovenMarginPct, setUnprovenMarginPct } from "@/lib/sourcingAgent";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const unprovenMarginPct = await getUnprovenMarginPct();
  return NextResponse.json({ unprovenMarginPct });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const value = Number(body.unprovenMarginPct);
  if (!Number.isFinite(value) || value < 0 || value > 1000) {
    return NextResponse.json({ error: "Margin must be between 0% and 1000%." }, { status: 400 });
  }
  await setUnprovenMarginPct(value);
  return NextResponse.json({ unprovenMarginPct: value });
}
