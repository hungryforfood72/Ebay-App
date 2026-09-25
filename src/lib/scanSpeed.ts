import { AUTO_EXPIRED_NOTE } from "./expireListings";
import { parseBundleComponentUnits, unitsFor } from "./itemUnits";
import { prisma } from "./prisma";

// Scan-in speed per person, for the owner's /reports/scan-speed page.
//
// Nothing records a "started item / finished item" pair — what exists is
// the moment each scan was saved (Item, damaged and dud entries). So one
// scan's time is the gap since that same person's previous save. Gaps
// longer than the idle cutoff are a break (lunch, a phone call, the end of
// the day), not a slow scan: the scan after one starts a new stretch, and
// is timed from when its scan session was started if that was recent,
// otherwise left untimed. Untimed scans still count toward the totals,
// just not the per-hour rate, so a break never drags the rate down.

export type ScanKind = "item" | "multipack" | "bundle" | "damaged" | "dud";

// null person = scanned before who-scanned-it was recorded (2026-09-25).
export const UNKNOWN_PERSON = "__unknown__";

export type ScanEvent = {
  at: Date;
  kind: ScanKind;
  units: number;
  label: string;
};

export type TimedScan = ScanEvent & { seconds: number | null };

export type ScanStretch = {
  start: Date; // session start when that's what the first scan was timed from
  end: Date;
  scans: TimedScan[];
  units: number;
  timedUnits: number;
  timedSeconds: number;
};

export type SpeedTotals = {
  scans: number;
  units: number;
  timedScans: number;
  timedUnits: number;
  timedSeconds: number;
};

export function computeStretches(events: ScanEvent[], sessionStarts: Date[], idleCutoffSeconds: number): ScanStretch[] {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const starts = [...sessionStarts].sort((a, b) => a.getTime() - b.getTime());
  const cutoffMs = idleCutoffSeconds * 1000;
  const stretches: ScanStretch[] = [];
  let current: ScanStretch | null = null;
  let prevAt: Date | null = null;

  for (const e of sorted) {
    const gapMs = prevAt ? e.at.getTime() - prevAt.getTime() : Infinity;
    let seconds: number | null;
    if (current && gapMs <= cutoffMs) {
      seconds = gapMs / 1000;
    } else {
      // New stretch: time it from a session started since the last scan,
      // within the cutoff (the latest one, if several).
      const anchor = latestStartBetween(starts, prevAt, e.at, cutoffMs);
      seconds = anchor ? (e.at.getTime() - anchor.getTime()) / 1000 : null;
      current = {
        start: anchor ?? e.at,
        end: e.at,
        scans: [],
        units: 0,
        timedUnits: 0,
        timedSeconds: 0,
      };
      stretches.push(current);
    }
    current.scans.push({ ...e, seconds });
    current.end = e.at;
    current.units += e.units;
    if (seconds != null) {
      current.timedUnits += e.units;
      current.timedSeconds += seconds;
    }
    prevAt = e.at;
  }
  return stretches;
}

function latestStartBetween(starts: Date[], after: Date | null, at: Date, cutoffMs: number): Date | null {
  let found: Date | null = null;
  for (const s of starts) {
    if (s.getTime() > at.getTime()) break;
    if (after && s.getTime() <= after.getTime()) continue;
    if (at.getTime() - s.getTime() <= cutoffMs) found = s;
  }
  return found;
}

export function totalsFor(scans: TimedScan[]): SpeedTotals {
  const t: SpeedTotals = {
    scans: 0,
    units: 0,
    timedScans: 0,
    timedUnits: 0,
    timedSeconds: 0,
  };
  for (const s of scans) {
    t.scans++;
    t.units += s.units;
    if (s.seconds != null) {
      t.timedScans++;
      t.timedUnits += s.units;
      t.timedSeconds += s.seconds;
    }
  }
  return t;
}

// Everything one person scanned in since `since` (null = all time), plus
// the scan sessions they started, ready for computeStretches.
export async function loadScanEvents(person: string, since: Date | null) {
  const who = person === UNKNOWN_PERSON ? null : person;
  const createdAt = since ? { gte: since } : undefined;

  const [items, damaged, duds, sessions] = await Promise.all([
    prisma.item.findMany({
      where: { scannedBy: who, createdAt },
      select: {
        createdAt: true,
        upc: true,
        quantity: true,
        isMultipack: true,
        packSize: true,
        isBundle: true,
        bundleComponents: true,
        finalTitle: true,
        aiTitle: true,
      },
    }),
    prisma.manifestDamagedEntry.findMany({
      // Spelled out with note: null — a bare NOT(note = …) is NULL in SQL
      // for a null note, which would silently drop every note-less scan.
      where: {
        recordedBy: who,
        createdAt,
        OR: [{ note: null }, { note: { not: AUTO_EXPIRED_NOTE } }],
      },
      select: { createdAt: true, upc: true, quantity: true },
    }),
    prisma.manifestDudEntry.findMany({
      where: { recordedBy: who, createdAt },
      select: { createdAt: true, upc: true, quantity: true },
    }),
    // A little before `since`, so a stretch that begins right at the edge
    // of the range can still be timed from its session start.
    prisma.scanSession.findMany({
      where: {
        startedBy: who,
        startedAt: since ? { gte: new Date(since.getTime() - 60 * 60 * 1000) } : undefined,
      },
      select: { startedAt: true },
    }),
  ]);

  const events: ScanEvent[] = [
    ...items.map((i): ScanEvent => {
      const title = i.finalTitle ?? i.aiTitle ?? (i.upc ? `UPC ${i.upc}` : "Item");
      if (i.isBundle) {
        const components = parseBundleComponentUnits(i.bundleComponents);
        return {
          at: i.createdAt,
          kind: "bundle",
          units: components.reduce((sum, c) => sum + c.unitsPerBundle, 0) * i.quantity,
          label: title,
        };
      }
      return {
        at: i.createdAt,
        kind: i.isMultipack ? "multipack" : "item",
        units: unitsFor(i),
        label: title,
      };
    }),
    ...damaged.map((d): ScanEvent => ({
      at: d.createdAt,
      kind: "damaged",
      units: d.quantity,
      label: `UPC ${d.upc}`,
    })),
    ...duds.map((d): ScanEvent => ({
      at: d.createdAt,
      kind: "dud",
      units: d.quantity,
      label: `UPC ${d.upc}`,
    })),
  ];

  return { events, sessionStarts: sessions.map((s) => s.startedAt) };
}
