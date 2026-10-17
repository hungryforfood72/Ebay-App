import { syncEbaySales } from "@/lib/channelSync";
import { updatePackStrategyKnowledge } from "@/lib/packAdvisor";
import { runPredictionTracker } from "@/lib/predictionTracker";
import { runShopifySync } from "@/lib/shopifySync";
import { updateSourcingKnowledge } from "@/lib/sourcingAgent";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// Every 4 hours (vercel.json): the full eBay order sync, including the
// recheck of recent sales still waiting on a shipping label or ad fee,
// then the knowledge updates, then another try at any item that failed to
// go up on Shopify. Same CRON_SECRET check as sync-ebay-orders.
export async function GET(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const sales = await syncEbaySales("full");

  // Only does real (LLM) work for scopes with genuinely new outcome data
  // since their notes were last updated. A failure here must never fail
  // the order sync itself, which is the far more operationally important
  // half of this job.
  try {
    await updateSourcingKnowledge();
  } catch (e) {
    console.error("[cron] updateSourcingKnowledge failed", e);
  }
  try {
    await updatePackStrategyKnowledge();
  } catch (e) {
    console.error("[cron] updatePackStrategyKnowledge failed", e);
  }
  // The Analyzer's report card: guesses vs real results on bought loads,
  // and the corrections its next evaluations use.
  try {
    await runPredictionTracker();
  } catch (e) {
    console.error("[cron] runPredictionTracker failed", e);
  }

  const shopify = await runShopifySync({ items: [], publish: { limit: 25, retryFailed: true } });
  return NextResponse.json({ ...sales, shopifyRetry: shopify });
}
