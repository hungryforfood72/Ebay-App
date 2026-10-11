import { ownerOnly } from "@/lib/auth";
import { getSaleAlertStatus, setUpSaleAlerts } from "@/lib/ebayNotifications";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  return NextResponse.json(await getSaleAlertStatus());
}

// Turns eBay's instant sale alerts on (or repairs them), pointed at
// whatever domain Settings was opened on.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  try {
    await setUpSaleAlerts(`${request.nextUrl.origin}/api/ebay/notifications`);
    return NextResponse.json(await getSaleAlertStatus());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
