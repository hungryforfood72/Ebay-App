import { syncEbayOrders } from "@/lib/ebayOrderSync";
import { updateSourcingKnowledge } from "@/lib/sourcingAgent";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 90;

// Triggered by Vercel Cron (see vercel.json) — Vercel sends
// `Authorization: Bearer $CRON_SECRET` automatically on requests it
// generates from that config; anything else is rejected.
export async function GET(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await syncEbayOrders();

  // Piggybacks on this existing 4-hourly schedule rather than needing its
  // own cron entry — only does real (LLM) work for scopes with genuinely
  // new outcome data since their notes were last updated. A failure here
  // must never fail the order sync itself, which is the far more
  // operationally important half of this job.
  try {
    await updateSourcingKnowledge();
  } catch (e) {
    console.error("[cron] updateSourcingKnowledge failed", e);
  }

  return NextResponse.json(result);
}
