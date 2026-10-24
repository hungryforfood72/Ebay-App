import { prisma } from "@/lib/prisma";
import { toPrintJobRow } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Recent print jobs at a station, newest first, for the station page's
// print log (with its Reprint buttons). ?limit= up to 100, default 25.
//
// Also tidies up jobs a station claimed but never reported on (the tab was
// closed or the PC lost power mid-print): after a couple of minutes they're
// marked failed so they show up with a Reprint button instead of sitting
// on "printing" forever. Not re-queued automatically, since the label may
// well have come out and a duplicate on the wrong bag is worse.
const STUCK_PRINTING_MS = 2 * 60_000;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? 25);
  const limit = Number.isInteger(limitParam) ? Math.min(100, Math.max(1, limitParam)) : 25;

  await prisma.printJob.updateMany({
    where: {
      stationId: id,
      status: "printing",
      // Jobs taken before claimedAt existed have none: fall back to createdAt.
      OR: [
        { claimedAt: { lt: new Date(Date.now() - STUCK_PRINTING_MS) } },
        { claimedAt: null, createdAt: { lt: new Date(Date.now() - STUCK_PRINTING_MS) } },
      ],
    },
    data: { status: "failed", error: "The station page closed before it said this printed. Check for the label." },
  });
  const jobs = await prisma.printJob.findMany({
    where: { stationId: id },
    orderBy: { seq: "desc" },
    take: limit,
  });
  return NextResponse.json(jobs.map(toPrintJobRow));
}
