import { logActivity } from "@/lib/activityLog";
import { ownerOnly } from "@/lib/auth";
import { getBackupSummary, getRestoreFailures, runListingBackup } from "@/lib/listingBackup";
import { withSyncLock } from "@/lib/syncLock";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// GET: what's backed up. POST: back up now ({ acceptDrop: true } = the
// listings eBay stopped showing really did end).
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const [summary, restoreFailures] = await Promise.all([getBackupSummary(), getRestoreFailures()]);
  return NextResponse.json({ ...summary, restoreFailures });
}

export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as { acceptDrop?: boolean };
  const run = await withSyncLock("listing-backup", "full", () =>
    runListingBackup({ budgetMs: 240_000, acceptDrop: body.acceptDrop === true })
  );
  if (!run.ran) return NextResponse.json({ error: "A backup is already running. Try again in a few minutes." }, { status: 409 });
  if (body.acceptDrop) {
    await logActivity({ request }, { action: "listingBackup.acceptDrop", summary: "Confirmed listings eBay stopped showing really ended" });
  }
  return NextResponse.json(run.results[run.results.length - 1]);
}
