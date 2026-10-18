import { logActivity } from "@/lib/activityLog";
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
  const before = await getTargetMarginPct();
  await setTargetMarginPct(value);
  await logActivity({ request }, { action: "setting", summary: `Target margin %: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`, targetType: "setting", targetId: "sourcing-target-margin", before, after: value });
  return NextResponse.json({ targetMarginPct: value });
}
