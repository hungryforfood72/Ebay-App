"use client";

import { Stat } from "@/components/Stat";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Field, Select } from "@/components/ui/Input";
import { ChevronDown, LoaderCircle, Timer } from "lucide-react";
import { useEffect, useState } from "react";

type Station = "sort" | "list" | "bin" | "shelve" | "pick" | "ship";

type ScanKind =
  | "good"
  | "extra"
  | "dud"
  | "damaged"
  | "return"
  | "item"
  | "multipack"
  | "bundle"
  | "bag"
  | "putaway"
  | "shelve"
  | "pick"
  | "label";

type Totals = {
  scans: number;
  units: number;
  timedScans: number;
  timedUnits: number;
  timedSeconds: number;
};

type Stretch = {
  start: string;
  end: string;
  units: number;
  timedUnits: number;
  timedSeconds: number;
  scans: {
    at: string;
    station: Station;
    kind: ScanKind;
    units: number;
    label: string;
    seconds: number | null;
  }[];
};

type Report = {
  generatedAt: string;
  days: number;
  idleMinutes: number;
  stations: Station[];
  team: {
    person: string;
    label: string;
    total: Totals;
    stations: Partial<Record<Station, Totals>>;
    lastScan: { at: string; station: Station };
  }[];
  detail: {
    person: string;
    label: string;
    station: Station | null;
    totals: Totals;
    byKind: (Totals & { kind: ScanKind })[];
    stretches: Stretch[];
  } | null;
};

const UNKNOWN_PERSON = "__unknown__";

// unit = what one unit is at that station, for "12 bags/hr" and the hints.
const STATION_LABELS: Record<Station, { label: string; unit: string; tone: BadgeTone }> = {
  sort: { label: "Sorting", unit: "unit", tone: "warning" },
  list: { label: "Listing", unit: "unit", tone: "primary" },
  bin: { label: "Binning", unit: "bag", tone: "purple" },
  shelve: { label: "Shelving", unit: "bin", tone: "neutral" },
  pick: { label: "Pick & pack", unit: "unit", tone: "success" },
  ship: { label: "Ship labels", unit: "label", tone: "danger" },
};

const KIND_LABELS: Record<ScanKind, { label: string; tone: BadgeTone }> = {
  good: { label: "Good (sort box)", tone: "success" },
  extra: { label: "Extra, not on manifest", tone: "neutral" },
  dud: { label: "Dud", tone: "warning" },
  damaged: { label: "Damaged/expired", tone: "danger" },
  return: { label: "Back to supplier", tone: "neutral" },
  item: { label: "Single item", tone: "neutral" },
  multipack: { label: "Multipack", tone: "primary" },
  bundle: { label: "Bundle", tone: "purple" },
  bag: { label: "Bag into bin", tone: "purple" },
  putaway: { label: "Put away", tone: "neutral" },
  shelve: { label: "Bin onto shelf", tone: "neutral" },
  pick: { label: "Picked", tone: "success" },
  label: { label: "Label printed", tone: "danger" },
};

// days = 1 is "Today": since the viewer's own midnight, not the last 24 hrs.
const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 0, label: "All time" },
];

const IDLE_CUTOFFS = [5, 10, 15, 20, 30];

// Owner-only (proxy.ts + the API route): how fast each person works at
// each station, from the time between their saves. See src/lib/scanSpeed.ts
// for where each station's scans come from and how breaks are kept out of
// the rate.
export default function ScanSpeedPage() {
  const [person, setPerson] = useState<string | null>(null);
  const [station, setStation] = useState<Station | null>(null);
  const [days, setDays] = useState(7);
  const [idleMinutes, setIdleMinutes] = useState(10);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped every minute on "Today", so the floor's numbers stay live.
  const [tick, setTick] = useState(0);
  // Which filters the report on screen (or the last error) was for — it's
  // loading whenever that doesn't match the filters picked now.
  const filterKey = `${person}|${station}|${days}|${idleMinutes}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== filterKey;

  useEffect(() => {
    const params = new URLSearchParams({ days: String(days), idle: String(idleMinutes) });
    if (days === 1) {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      params.set("since", midnight.toISOString());
    }
    if (person) params.set("person", person);
    if (station) params.set("station", station);
    let cancelled = false;
    fetch(`/api/reports/scan-speed?${params}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Couldn't load the report.");
        return data as Report;
      })
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load the report."))
      .finally(() => !cancelled && setLoadedKey(filterKey));
    return () => {
      cancelled = true;
    };
  }, [person, station, days, idleMinutes, filterKey, tick]);

  useEffect(() => {
    if (days !== 1) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [days]);

  const d = report?.detail;
  const t = d?.totals;
  const unitsPerHour = t ? ratePerHour(t.timedUnits, t.timedSeconds) : null;
  const scansPerHour = t ? ratePerHour(t.timedScans, t.timedSeconds) : null;
  const unit = d?.station ? STATION_LABELS[d.station].unit : "unit";

  function pick(p: string, st: Station | null) {
    setPerson(p);
    setStation(st);
    document.getElementById("person-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <AppShell title="Scan speed" subtitle="How fast each person works at each station.">
      <div className="flex flex-col gap-6">
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Range">
              <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {RANGES.map((r) => (
                  <option key={r.days} value={r.days}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Count it as a break after">
              <Select value={idleMinutes} onChange={(e) => setIdleMinutes(Number(e.target.value))}>
                {IDLE_CUTOFFS.map((m) => (
                  <option key={m} value={m}>
                    {m} min with no scan
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Each scan is timed from that person&apos;s previous save, at any station. A gap longer than the break cutoff
            is left out of the rate, so lunch or a phone call doesn&apos;t make the pace look slower. Scans go to
            whoever is signed in on the scanner, so everyone needs their own login.
            {days === 1 && " Today refreshes every minute."}
          </p>
        </Card>

        {error && <Alert tone="danger">{error}</Alert>}

        {!report && loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" aria-hidden /> Loading…
          </div>
        )}

        {report && report.team.length === 0 && (
          <Card className="py-10 text-center">
            <Timer className="mx-auto size-8 text-muted-foreground" aria-hidden />
            <p className="mt-2 font-medium text-foreground">No scans in this range.</p>
          </Card>
        )}

        {report && report.team.length > 0 && (
          <div className={cn("flex flex-col gap-6 transition-opacity", loading && "opacity-60")}>
            <TeamCard report={report} selected={d?.person ?? null} onPick={pick} />

            {d && t && (
              <section id="person-detail" className="flex scroll-mt-4 flex-col gap-4">
                <Card>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Person">
                      <Select value={d.person} onChange={(e) => setPerson(e.target.value)}>
                        {report.team.map((p) => (
                          <option key={p.person} value={p.person}>
                            {p.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Station">
                      <Select
                        value={d.station ?? ""}
                        onChange={(e) => setStation((e.target.value || null) as Station | null)}
                      >
                        <option value="">All stations</option>
                        {report.stations.map((st) => (
                          <option key={st} value={st}>
                            {STATION_LABELS[st].label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                </Card>

                {d.person === UNKNOWN_PERSON && (
                  <Alert tone="info">
                    These were scanned before the app started recording who did the scanning, so they could be
                    anyone&apos;s.
                  </Alert>
                )}

                {t.scans === 0 ? (
                  <Card className="py-10 text-center">
                    <Timer className="mx-auto size-8 text-muted-foreground" aria-hidden />
                    <p className="mt-2 font-medium text-foreground">
                      No {d.station ? STATION_LABELS[d.station].label.toLowerCase() : ""} scans by {d.label} in this
                      range.
                    </p>
                  </Card>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <Stat
                        label={`${capitalize(unit)}s per hour`}
                        value={unitsPerHour != null ? Math.round(unitsPerHour) : "—"}
                        hint={unitsPerHour != null ? projection(unitsPerHour) : "Not enough timed scans yet"}
                      />
                      <Stat
                        label="Scans per hour"
                        value={scansPerHour != null ? Math.round(scansPerHour) : "—"}
                        hint="Each save counts once"
                      />
                      <Stat
                        label="Avg time per scan"
                        value={t.timedScans ? formatDuration(t.timedSeconds / t.timedScans) : "—"}
                      />
                      <Stat
                        label="Time working"
                        value={formatDuration(t.timedSeconds)}
                        hint={`${plural(t.units, unit)} in ${plural(t.scans, "scan")}`}
                      />
                    </div>
                    {t.timedSeconds < 30 * 60 && (
                      <p className="text-sm text-muted-foreground">
                        Only {formatDuration(t.timedSeconds)} of timed work so far, so treat the rate as rough. It
                        settles down as more gets scanned.
                      </p>
                    )}
                    {t.scans > t.timedScans && (
                      <p className="text-xs text-muted-foreground">
                        {plural(t.scans - t.timedScans, "scan")} came right after a break, so there was nothing to
                        time them from. They count in the totals, not the per-hour rate.
                      </p>
                    )}

                    {d.byKind.length > 1 && (
                      <Card padded={false}>
                        <div className="p-4 pb-0 sm:p-5 sm:pb-0">
                          <SectionHeader
                            title="By type of scan"
                            description="Bundles, multipacks and duds usually take longer."
                          />
                        </div>
                        <ul className="divide-y divide-border">
                          {d.byKind.map((k) => (
                            <li key={k.kind} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                              <div className="min-w-0">
                                <Badge tone={KIND_LABELS[k.kind].tone}>{KIND_LABELS[k.kind].label}</Badge>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {plural(k.scans, "scan")} · {plural(k.units, "unit")}
                                </p>
                              </div>
                              <div className="shrink-0 text-right">
                                <p className="font-semibold tabular-nums text-foreground">
                                  {k.timedScans ? formatDuration(k.timedSeconds / k.timedScans) : "—"}
                                </p>
                                <p className="text-xs text-muted-foreground">avg per scan</p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </Card>
                    )}

                    <section>
                      <SectionHeader
                        title="Work stretches"
                        description="Back-to-back scans with no break. Tap one to see each scan."
                      />
                      <div className="flex flex-col gap-3">
                        {d.stretches.map((s) => (
                          <StretchCard key={s.start} stretch={s} unit={unit} showStation={!d.station} />
                        ))}
                      </div>
                    </section>
                  </>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

// Everyone side by side: per hour at each station. A cell picks that
// person + station for the detail below; the name picks all their stations.
function TeamCard({
  report,
  selected,
  onPick,
}: {
  report: Report;
  selected: string | null;
  onPick: (person: string, station: Station | null) => void;
}) {
  // "Working now" / "5 min ago" as of when the report was built.
  const now = new Date(report.generatedAt).getTime();
  return (
    <Card padded={false}>
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <SectionHeader
          title="Team"
          description="Per hour at each station, with the total done under it. Tap a number for that person's details."
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium sm:px-5">Person</th>
              {report.stations.map((st) => (
                <th key={st} className="px-3 py-2 text-right font-medium">
                  {STATION_LABELS[st].label}
                  <span className="block font-normal">{STATION_LABELS[st].unit}s/hr</span>
                </th>
              ))}
              <th className="px-4 py-2 text-right font-medium sm:px-5">Last scan</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {report.team.map((row) => {
              const lastAt = new Date(row.lastScan.at);
              const active = now - lastAt.getTime() <= report.idleMinutes * 60 * 1000;
              return (
                <tr key={row.person} className={cn(row.person === selected && "bg-muted/60")}>
                  <td className="px-4 py-2.5 sm:px-5">
                    <button
                      type="button"
                      onClick={() => onPick(row.person, null)}
                      className="font-medium text-foreground hover:underline"
                    >
                      {row.label}
                    </button>
                  </td>
                  {report.stations.map((st) => {
                    const s = row.stations[st];
                    const rate = s ? ratePerHour(s.timedUnits, s.timedSeconds) : null;
                    return (
                      <td key={st} className="px-3 py-2.5 text-right tabular-nums">
                        {s ? (
                          <button type="button" onClick={() => onPick(row.person, st)} className="hover:underline">
                            <span className="block font-semibold text-foreground">
                              {rate != null ? Math.round(rate) : "—"}
                            </span>
                            <span className="block text-xs text-muted-foreground">{s.units} done</span>
                          </button>
                        ) : (
                          <span className="text-muted-foreground">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2.5 text-right sm:px-5">
                    <span className="flex items-center justify-end gap-1.5 text-foreground">
                      {active && <span className="size-2 rounded-full bg-success" aria-label="Working now" />}
                      {STATION_LABELS[row.lastScan.station].label}
                    </span>
                    <span className="block text-xs text-muted-foreground">{ago(now - lastAt.getTime())}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function StretchCard({ stretch: s, unit, showStation }: { stretch: Stretch; unit: string; showStation: boolean }) {
  const [open, setOpen] = useState(false);
  const rate = ratePerHour(s.timedUnits, s.timedSeconds);
  const start = new Date(s.start);
  const end = new Date(s.end);
  const stations = [...new Set(s.scans.map((x) => x.station))];

  return (
    <Card padded={false}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left sm:px-5"
      >
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {start.toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
          </p>
          <p className="text-sm tabular-nums text-muted-foreground">
            {formatTime(start)} – {formatTime(end)}
            {s.timedSeconds > 0 && ` · ${formatDuration(s.timedSeconds)}`}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {plural(s.scans.length, "scan")} · {plural(s.units, unit)}
          </p>
          {showStation && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {stations.map((st) => (
                <Badge key={st} tone={STATION_LABELS[st].tone}>
                  {STATION_LABELS[st].label}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-semibold tabular-nums text-foreground">{rate != null ? Math.round(rate) : "—"}</p>
          <p className="text-xs text-muted-foreground">{unit}s/hr</p>
        </div>
        <ChevronDown
          className={cn("size-5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open && (
        <ul className="divide-y divide-border border-t border-border">
          {s.scans.map((scan, i) => (
            <li key={`${scan.at}-${i}`} className="flex items-start gap-3 px-4 py-2.5 text-sm sm:px-5">
              <span className="w-16 shrink-0 tabular-nums text-muted-foreground">{formatTime(new Date(scan.at))}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-foreground">{scan.label}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={KIND_LABELS[scan.kind].tone}>{KIND_LABELS[scan.kind].label}</Badge>
                  <span className="text-xs text-muted-foreground">{plural(scan.units, STATION_LABELS[scan.station].unit)}</span>
                </div>
              </div>
              <span className="shrink-0 text-right tabular-nums text-foreground">
                {scan.seconds != null ? (
                  formatDuration(scan.seconds)
                ) : (
                  <span className="text-muted-foreground">not timed</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ratePerHour(count: number, seconds: number): number | null {
  return seconds > 0 ? count / (seconds / 3600) : null;
}

function projection(perHour: number): string {
  return `≈${Math.round(perHour * 4)} in 4 hrs · ${Math.round(perHour * 8)} in 8`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  // Seconds only matter for short spans (a single scan's time).
  const rem = m >= 10 ? 0 : s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
