import { logActivity } from "@/lib/activityLog";
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
  const before = await getUnprovenMarginPct();
  await setUnprovenMarginPct(value);
  await logActivity({ request }, { action: "setting", summary: `Unproven margin %: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`, targetType: "setting", targetId: "sourcing-unproven-margin", before, after: value });
  return NextResponse.json({ unprovenMarginPct: value });
}
