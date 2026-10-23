import { runListingBackup } from "@/lib/listingBackup";
import { withSyncLock } from "@/lib/syncLock";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// Hourly (vercel.json): copies every live eBay listing into
// EbayListingBackup (src/lib/listingBackup.ts). Same CRON_SECRET check as
// the other crons.
export async function GET(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const run = await withSyncLock("listing-backup", "full", () => runListingBackup({ budgetMs: 240_000 }));
  return NextResponse.json(run.ran ? run.results[run.results.length - 1] : { skipped: "already running" });
}
