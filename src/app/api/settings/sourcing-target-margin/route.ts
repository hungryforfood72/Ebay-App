import { getTargetMarginPct, setTargetMarginPct } from "@/lib/sourcingAgent";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const targetMarginPct = await getTargetMarginPct();
  return NextResponse.json({ targetMarginPct });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const value = Number(body.targetMarginPct);
  if (!Number.isFinite(value) || value <= 0 || value > 500) {
    return NextResponse.json({ error: "Target margin must be a positive number." }, { status: 400 });
  }
  await setTargetMarginPct(value);
  return NextResponse.json({ targetMarginPct: value });
}
