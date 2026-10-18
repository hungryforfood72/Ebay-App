import { ownerOnly } from "@/lib/auth";
import { sendTestDeliveryEmail } from "@/lib/delivery/deliveries";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Owner only: sends the delivered-with-photo email, with a made-up order,
// to { to }, to check the Gmail setup.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return NextResponse.json({ error: "Enter an email address." }, { status: 400 });
  try {
    await sendTestDeliveryEmail(to);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
