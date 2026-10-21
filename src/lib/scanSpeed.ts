import { AUTO_EXPIRED_NOTE } from "./expireListings";
import { NOT_RETURN_ENTRY } from "./warehouse/returnReconcile";
import { parseBundleComponentUnits, unitsFor } from "./itemUnits";
import { prisma } from "./prisma";

// Scan speed per person and per station, for the owner's
// /reports/scan-speed page.
//
// Nothing records a "started item / finished item" pair — what exists is
// the moment each scan was saved, at every station:
//   sort   — SortBoxEntry (good/extra), dud and damaged entries, consignment
//            set-asides
//   list   — Item
//   bin    — BinMove "place" from the binning station (and put-away)
//   shelve — BinMove "shelve"
//   pick   — OrderPick
//   ship   — ShippingLabel printed by scanning a pick slip
// So one scan's time is the gap since that same person's previous save, at
// any station: someone who sorts and then bins gets each gap credited to
// the station of the scan that ended it. Gaps longer than the idle cutoff
// are a break (lunch, a phone call, the end of the day), not a slow scan:
// the scan after one starts a new stretch, and is timed from when its scan
// session was started if that was recent, otherwise left untimed. Scan
// sessions stopped being created on 2026-09-27, so only older scans can
// still be timed that way. Untimed scans still count toward the totals,
// just not the per-hour rate, so a break never drags the rate down.
//
// Who did it is whoever was signed in on the scanner, so people sharing one
// login all show up as that one person.

export const STATIONS = ["sort", "list", "bin", "shelve", "pick", "ship"] as const;
export type Station = (typeof STATIONS)[number];

export type ScanKind =
  // sort
  | "good"
  | "extra"
  | "dud"
  | "damaged"
  | "return"
  // list
  | "item"
  | "multipack"
  | "bundle"
  // bin
  | "bag"
  | "putaway"
  // shelve, pick, ship
  | "shelve"
  | "pick"
  | "label";

// null person = scanned before who-scanned-it was recorded (2026-09-25).
export const UNKNOWN_PERSON = "__unknown__";

export type ScanEvent = {
  at: Date;
  person: string;
  station: Station;
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

// One person's events (any stations) -> their stretches.
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

// A stretch cut down to one station's scans (null = all), with its totals
// redone. null when none of its scans were at that station.
export function stretchAt(s: ScanStretch, station: Station | null): ScanStretch | null {
  if (!station) return s;
  const scans = s.scans.filter((x) => x.station === station);
  if (scans.length === 0) return null;
  const t = totalsFor(scans);
  return {
    start: scans[0].at,
    end: scans[scans.length - 1].at,
    scans,
    units: t.units,
    timedUnits: t.timedUnits,
    timedSeconds: t.timedSeconds,
  };
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

// Every scan at every station since `since` (null = all time), by everyone
// or one person, plus the scan sessions each person started, ready for
// computeStretches (group by person first).
export async function loadScanEvents(since: Date | null, person?: string) {
  // undefined = everyone; null = the scans from before who was recorded.
  const who = person === undefined ? undefined : person === UNKNOWN_PERSON ? null : person;
  const createdAt = since ? { gte: since } : undefined;
  const key = (by: string | null) => by ?? UNKNOWN_PERSON;

  const [items, sorted, damaged, duds, returns, binMoves, picks, labels, sessions] = await Promise.all([
    prisma.item.findMany({
      where: { scannedBy: who, createdAt },
      select: {
        createdAt: true,
        scannedBy: true,
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
    prisma.sortBoxEntry.findMany({
      where: { recordedBy: who, createdAt },
      select: { createdAt: true, recordedBy: true, upc: true, quantity: true, extra: true },
    }),
    prisma.manifestDamagedEntry.findMany({
      // Spelled out with note: null — a bare NOT(note = …) is NULL in SQL
      // for a null note, which would silently drop every note-less scan.
      where: {
        recordedBy: who,
        createdAt,
        OR: [{ note: null }, { note: { not: AUTO_EXPIRED_NOTE } }],
        // Units a customer return wrote off aren't sort-station scans.
        AND: [NOT_RETURN_ENTRY],
      },
      select: { createdAt: true, recordedBy: true, upc: true, quantity: true },
    }),
    prisma.manifestDudEntry.findMany({
      where: { recordedBy: who, createdAt, ...NOT_RETURN_ENTRY },
      select: { createdAt: true, recordedBy: true, upc: true, quantity: true },
    }),
    prisma.consignmentReturnEntry.findMany({
      where: { recordedBy: who, createdAt },
      select: { createdAt: true, recordedBy: true, upc: true, description: true, quantity: true },
    }),
    // Bin station scans (one bag = one unit), put-aways and shelving. Not
    // the place a listing makes when it's saved straight into a bin (that's
    // the listing scan itself) or picks/undos.
    prisma.binMove.findMany({
      where: {
        by: who,
        createdAt,
        OR: [{ kind: "place", note: { in: ["Binned", "Put away"] } }, { kind: "shelve" }],
      },
      select: { createdAt: true, by: true, kind: true, note: true, units: true, toBinCode: true, fromBinCode: true, shelfLabel: true },
    }),
    prisma.orderPick.findMany({
      where: { pickedBy: who, createdAt },
      select: { createdAt: true, pickedBy: true, item: { select: { sku: true, finalTitle: true, aiTitle: true } } },
    }),
    prisma.shippingLabel.findMany({
      where: { printedBy: who, printedAt: since ? { gte: since } : { not: null } },
      select: { printedAt: true, printedBy: true, trackingNumber: true, orderIds: true },
    }),
    // A little before `since`, so a stretch that begins right at the edge
    // of the range can still be timed from its session start.
    prisma.scanSession.findMany({
      where: {
        startedBy: who,
        startedAt: since ? { gte: new Date(since.getTime() - 60 * 60 * 1000) } : undefined,
      },
      select: { startedAt: true, startedBy: true },
    }),
  ]);

  const events: ScanEvent[] = [
    ...items.map((i): ScanEvent => {
      const title = i.finalTitle ?? i.aiTitle ?? (i.upc ? `UPC ${i.upc}` : "Item");
      const base = { at: i.createdAt, person: key(i.scannedBy), station: "list" as const, label: title };
      if (i.isBundle) {
        const components = parseBundleComponentUnits(i.bundleComponents);
        return {
          ...base,
          kind: "bundle",
          units: components.reduce((sum, c) => sum + c.unitsPerBundle, 0) * i.quantity,
        };
      }
      return { ...base, kind: i.isMultipack ? "multipack" : "item", units: unitsFor(i) };
    }),
    ...sorted.map((e): ScanEvent => ({
      at: e.createdAt,
      person: key(e.recordedBy),
      station: "sort",
      kind: e.extra ? "extra" : "good",
      units: e.quantity,
      label: `UPC ${e.upc}`,
    })),
    ...damaged.map((d): ScanEvent => ({
      at: d.createdAt,
      person: key(d.recordedBy),
      station: "sort",
      kind: "damaged",
      units: d.quantity,
      label: `UPC ${d.upc}`,
    })),
    ...duds.map((d): ScanEvent => ({
      at: d.createdAt,
      person: key(d.recordedBy),
      station: "sort",
      kind: "dud",
      units: d.quantity,
      label: `UPC ${d.upc}`,
    })),
    ...returns.map((r): ScanEvent => ({
      at: r.createdAt,
      person: key(r.recordedBy),
      station: "sort",
      kind: "return",
      units: r.quantity,
      label: r.description || `UPC ${r.upc}`,
    })),
    ...binMoves.map((m): ScanEvent =>
      m.kind === "shelve"
        ? {
            at: m.createdAt,
            person: key(m.by),
            station: "shelve",
            kind: "shelve",
            units: 1,
            label: `${m.fromBinCode ?? "Bin"} → ${m.shelfLabel ?? "shelf"}`,
          }
        : {
            at: m.createdAt,
            person: key(m.by),
            station: "bin",
            kind: m.note === "Put away" ? "putaway" : "bag",
            units: m.units ?? 1,
            label: `Into ${m.toBinCode ?? "bin"}`,
          }
    ),
    ...picks.map((p): ScanEvent => ({
      at: p.createdAt,
      person: key(p.pickedBy),
      station: "pick",
      kind: "pick",
      units: 1,
      label: p.item.finalTitle ?? p.item.aiTitle ?? p.item.sku,
    })),
    ...labels.map((l): ScanEvent => ({
      at: l.printedAt!,
      person: key(l.printedBy),
      station: "ship",
      kind: "label",
      units: 1,
      label: l.orderIds.length > 0 ? `Order ${l.orderIds.join(", ")}` : (l.trackingNumber ?? "Shipping label"),
    })),
  ];

  const sessionStarts = new Map<string, Date[]>();
  for (const s of sessions) {
    const list = sessionStarts.get(key(s.startedBy));
    if (list) list.push(s.startedAt);
    else sessionStarts.set(key(s.startedBy), [s.startedAt]);
  }
  return { events, sessionStarts };
}
