import { getLongTailMonths, setLongTailMonths } from "@/lib/sourcingAgent";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const longTailMonths = await getLongTailMonths();
  return NextResponse.json({ longTailMonths });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const value = Number(body.longTailMonths);
  if (!Number.isFinite(value) || value <= 0 || value > 120) {
    return NextResponse.json({ error: "Months must be a positive number." }, { status: 400 });
  }
  await setLongTailMonths(value);
  return NextResponse.json({ longTailMonths: value });
}
