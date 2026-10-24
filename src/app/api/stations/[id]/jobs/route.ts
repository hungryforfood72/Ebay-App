import { claimJobs } from "@/lib/warehouse/printJobs";
import { NextRequest, NextResponse } from "next/server";

// The station page asking "anything to print?" (see claimJobs: oldest
// first, each job to one poller only, nothing while paused). ?kinds=label
// while the station's print helper prints the 4x6 pages, so the page only
// takes the small code labels; ?kinds=page while the helper prints the
// small labels. One query whether or not there's anything waiting: this
// runs every 1.5-5 seconds all day.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const kinds = request.nextUrl.searchParams.get("kinds");
  const which = kinds === "label" || kinds === "page" ? kinds : "all";
  return NextResponse.json(await claimJobs(id, which, true));
}
