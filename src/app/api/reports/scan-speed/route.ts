import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  computeStretches,
  loadScanEvents,
  STATIONS,
  stretchAt,
  totalsFor,
  UNKNOWN_PERSON,
  type ScanEvent,
  type ScanKind,
  type Station,
  type TimedScan,
} from "@/lib/scanSpeed";
import { NextRequest, NextResponse } from "next/server";

const KINDS: ScanKind[] = [
  "good",
  "extra",
  "dud",
  "damaged",
  "return",
  "item",
  "multipack",
  "bundle",
  "bag",
  "putaway",
  "shelve",
  "pick",
  "label",
];

// GET ?days=<7|30|90|0=all> or ?since=<ISO, e.g. the viewer's midnight for
// "Today">, &idle=<minutes>, &person=<username|__unknown__>,
// &station=<sort|list|bin|shelve|pick|ship> (detail filter; omit = all).
// -> { team: one row per person with scans (per-station totals + last
//      scan), detail: the picked person's totals/byKind/stretches }
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const days = Math.max(0, Number(params.get("days") ?? 7) || 0);
  const idleMinutes = Math.min(120, Math.max(1, Number(params.get("idle") ?? 10) || 10));
  const sinceParam = params.get("since");
  const sinceDate = sinceParam ? new Date(sinceParam) : null;
  const since =
    sinceDate && !Number.isNaN(sinceDate.getTime())
      ? sinceDate
      : days > 0
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        : null;
  const stationParam = params.get("station");
  const station = STATIONS.includes(stationParam as Station) ? (stationParam as Station) : null;

  const [users, { events, sessionStarts }] = await Promise.all([
    prisma.user.findMany({ select: { username: true, role: true }, orderBy: { username: "asc" } }),
    loadScanEvents(since),
  ]);

  const byPerson = new Map<string, ScanEvent[]>();
  for (const e of events) {
    const list = byPerson.get(e.person);
    if (list) list.push(e);
    else byPerson.set(e.person, [e]);
  }

  // Employees first: they're who this report is mostly for. Then anyone
  // whose scans are credited to a login that's since been deleted.
  const known = [...users.filter((u) => u.role === "employee"), ...users.filter((u) => u.role !== "employee")].map(
    (u) => u.username
  );
  const order = [...known, ...[...byPerson.keys()].filter((p) => !known.includes(p) && p !== UNKNOWN_PERSON).sort()];
  if (byPerson.has(UNKNOWN_PERSON)) order.push(UNKNOWN_PERSON);
  const labelFor = (p: string) => (p === UNKNOWN_PERSON ? "Unknown (before tracking)" : p);

  const scansByPerson = new Map<string, { stretches: ReturnType<typeof computeStretches>; scans: TimedScan[] }>();
  for (const p of order) {
    const evs = byPerson.get(p);
    if (!evs) continue;
    const stretches = computeStretches(evs, sessionStarts.get(p) ?? [], idleMinutes * 60);
    scansByPerson.set(p, { stretches, scans: stretches.flatMap((s) => s.scans) });
  }

  const team = order
    .filter((p) => scansByPerson.has(p))
    .map((p) => {
      const { scans } = scansByPerson.get(p)!;
      const last = scans[scans.length - 1];
      const stations: Partial<Record<Station, ReturnType<typeof totalsFor>>> = {};
      for (const st of STATIONS) {
        const t = totalsFor(scans.filter((s) => s.station === st));
        if (t.scans > 0) stations[st] = t;
      }
      return {
        person: p,
        label: labelFor(p),
        total: totalsFor(scans),
        stations,
        lastScan: { at: last.at, station: last.station },
      };
    });
  const stationsUsed = STATIONS.filter((st) => team.some((r) => r.stations[st]));

  // Detail: the person asked for, else the first one with scans.
  const requested = params.get("person");
  const person = requested && scansByPerson.has(requested) ? requested : (team[0]?.person ?? null);
  let detail = null;
  if (person) {
    const stretches = scansByPerson
      .get(person)!
      .stretches.map((s) => stretchAt(s, station))
      .filter((s): s is NonNullable<typeof s> => s != null);
    const scans = stretches.flatMap((s) => s.scans);
    detail = {
      person,
      label: labelFor(person),
      station,
      totals: totalsFor(scans),
      byKind: KINDS.map((kind) => ({ kind, ...totalsFor(scans.filter((s) => s.kind === kind)) })).filter(
        (k) => k.scans > 0
      ),
      stretches: stretches.reverse(),
    };
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    days,
    since: since?.toISOString() ?? null,
    idleMinutes,
    stations: stationsUsed,
    team,
    detail,
  });
}
