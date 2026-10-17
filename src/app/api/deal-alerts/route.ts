import { ownerOnly } from "@/lib/auth";
import { sendToAll, subscriberCount } from "@/lib/dealAlerts";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Settings' Deal alerts card: how many devices signed up, a test alert, and
// a one-off alert Cristian writes himself (a price drop, a sale).
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  return NextResponse.json({ subscribers: await subscriberCount() });
}

// Phones cut a notification off past roughly these lengths.
const MAX_TITLE = 65;
const MAX_BODY = 180;

export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const custom = typeof body.title === "string" && body.title.trim() !== "";
  let alert = { title: "Epic Steals test alert", body: "Deal alerts are working. Tap to open the store.", path: "/", tag: "test" };
  if (custom) {
    const title = body.title.trim();
    const text = typeof body.body === "string" ? body.body.trim() : "";
    const path = typeof body.path === "string" && body.path.trim().startsWith("/") ? body.path.trim() : "/";
    if (title.length > MAX_TITLE || text.length > MAX_BODY) {
      return NextResponse.json({ error: `Keep the title under ${MAX_TITLE} characters and the message under ${MAX_BODY}.` }, { status: 400 });
    }
    alert = { title, body: text, path, tag: "custom" };
  }
  try {
    const result = await sendToAll(alert);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
