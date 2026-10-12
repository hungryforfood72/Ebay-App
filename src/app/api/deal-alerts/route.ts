import { ownerOnly } from "@/lib/auth";
import { sendToAll, subscriberCount } from "@/lib/dealAlerts";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Settings' Deal alerts card: how many devices signed up, and a test alert.
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  return NextResponse.json({ subscribers: await subscriberCount() });
}

export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  try {
    const result = await sendToAll({
      title: "Epic Steals test alert",
      body: "Deal alerts are working. Tap to open the store.",
      path: "/",
      tag: "test",
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
