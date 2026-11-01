import { prisma } from "@/lib/prisma";
import { STATION_IDLE_MS, checkStationIdle, type IdleCheck } from "@/lib/stationIdle";
import { helperHasScale } from "@/lib/warehouse/printHelper";
import { claimJobs, type ClaimedJob } from "@/lib/warehouse/printJobs";
import { STATION_STATUS_SELECT, toStationStatus } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// The station page checking in: its latest scale reading, and proof it's
// still open (lastSeenAt drives "online"). Sent on every weight change
// (at most ~4 a second) and every few seconds otherwise.
//
// One call does everything the page needs (Cristian, 2026-11-01: it used to
// be three separate calls on their own timers, a big part of the Vercel
// bill). The body can also carry:
//   claim: "all" | "page" | "label": take this station's waiting jobs
//     (claimJobs, as GET /api/stations/{id}/jobs did)
//   idleMs: how long since anyone touched the station page. Past an hour,
//     see checkStationIdle: a station sign-in ends (401, idle: true).
// and the answer is { ok, station: StationStatus, jobs, activeAt? }.
// An older page that only sends the weight still works.
//
// weightAt is stamped on every heartbeat that has a reading, not only when
// the number changes, so a handheld can tell "the scale still reads 30 oz"
// apart from "the scale went quiet a minute ago at 30 oz".
//
// While the print helper has the scale (helperHasScale), the weight is the
// helper's: the page sends no weightOz, and an older page that still does
// is ignored, so the two never fight over it.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const weightOz = body.weightOz;
  const now = new Date();
  const station = await prisma.station.findUnique({ where: { id }, select: STATION_STATUS_SELECT });
  if (!station) {
    return NextResponse.json({ error: "This station was deleted. Pick another one." }, { status: 404 });
  }

  let idle: IdleCheck | null = null;
  if (typeof body.idleMs === "number" && body.idleMs >= STATION_IDLE_MS) {
    idle = await checkStationIdle(request, station, body.idleMs);
    if (idle.state === "signed-out") {
      return NextResponse.json({ error: "Signed out: nobody used this station for an hour.", idle: true }, { status: 401 });
    }
    if (idle.state === "idle") return NextResponse.json({ ok: true, idle: true });
  }

  if (weightOz === undefined || helperHasScale(station, now.getTime())) {
    await prisma.station.updateMany({ where: { id }, data: { lastSeenAt: now } });
    station.lastSeenAt = now;
  } else {
    if (weightOz !== null && !(typeof weightOz === "number" && Number.isFinite(weightOz) && weightOz >= 0 && weightOz < 1_000_000)) {
      return NextResponse.json({ error: "weightOz must be a number of ounces or null." }, { status: 400 });
    }
    if (typeof body.stable !== "boolean") {
      return NextResponse.json({ error: "stable must be true or false." }, { status: 400 });
    }
    // updateMany so a deleted station is a count of 0, not a thrown error.
    const { count } = await prisma.station.updateMany({
      where: { id },
      data: {
        weightOz: weightOz === null ? null : Math.round(weightOz * 100) / 100,
        weightStable: weightOz !== null && body.stable,
        weightAt: weightOz === null ? null : now,
        lastSeenAt: now,
      },
    });
    if (count === 0) {
      return NextResponse.json({ error: "This station was deleted. Pick another one." }, { status: 404 });
    }
    station.lastSeenAt = now;
  }

  const claim = body.claim;
  const jobs: ClaimedJob[] = claim === "all" || claim === "page" || claim === "label" ? await claimJobs(id, claim, true) : [];
  return NextResponse.json({
    ok: true,
    station: toStationStatus(station, now.getTime()),
    jobs,
    ...(idle?.state === "active" ? { activeAt: idle.activeAt } : {}),
  });
}
