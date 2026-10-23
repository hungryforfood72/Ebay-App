import { logActivity } from "@/lib/activityLog";
import { ownerOnly } from "@/lib/auth";
import { getRestorePreflight, restoreListings } from "@/lib/listingBackup";
import { withSyncLock } from "@/lib/syncLock";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// GET: which account is connected and what's waiting to go onto it.
// POST: re-list the next batch onto it; the page keeps calling until
// nothing's left. { retryFailed: true } also retries ones that failed.
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  return NextResponse.json(await getRestorePreflight());
}

export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { retryFailed?: boolean };
  try {
    const run = await withSyncLock("listing-restore", "full", () =>
      restoreListings({ budgetMs: 200_000, retryFailed: body.retryFailed === true })
    );
    if (!run.ran) return NextResponse.json({ error: "A restore batch is already running." }, { status: 409 });
    const result = run.results[run.results.length - 1];
    await logActivity(
      { request },
      {
        action: "listingBackup.restore",
        summary: `Re-listed ${result.restored} listings onto eBay account ${result.connectedSellerId} (${result.failed.length} failed, ${result.remaining} left)`,
        after: result,
      }
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Restore failed." }, { status: 500 });
  }
}
