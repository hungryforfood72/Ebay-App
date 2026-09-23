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
  await setMaxMonthsToSellThrough(value);
  return NextResponse.json({ maxMonthsToSellThrough: value });
}
