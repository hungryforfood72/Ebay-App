import { logActivity } from "@/lib/activityLog";
import { getMaxMonthsToSellThrough, setMaxMonthsToSellThrough } from "@/lib/sourcingAgent";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const maxMonthsToSellThrough = await getMaxMonthsToSellThrough();
  return NextResponse.json({ maxMonthsToSellThrough });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const value = Number(body.maxMonthsToSellThrough);
  if (!Number.isFinite(value) || value <= 0 || value > 120) {
    return NextResponse.json({ error: "Max months to sell through must be a positive number." }, { status: 400 });
  }
  const before = await getMaxMonthsToSellThrough();
  await setMaxMonthsToSellThrough(value);
  await logActivity({ request }, { action: "setting", summary: `Max months to sell through: ${JSON.stringify(before)} -> ${JSON.stringify(value)}`, targetType: "setting", targetId: "sourcing-max-months-to-sell", before, after: value });
  return NextResponse.json({ maxMonthsToSellThrough: value });
}
