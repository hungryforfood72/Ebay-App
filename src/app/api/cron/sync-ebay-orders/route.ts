import { syncEbayOrders } from "@/lib/ebayOrderSync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Triggered by Vercel Cron (see vercel.json) — Vercel sends
// `Authorization: Bearer $CRON_SECRET` automatically on requests it
// generates from that config; anything else is rejected.
export async function GET(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await syncEbayOrders();
  return NextResponse.json(result);
}
