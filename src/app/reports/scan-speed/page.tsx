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

type ScanKind = "item" | "multipack" | "bundle" | "damaged" | "dud";

type Totals = {
  scans: number;
  units: number;
  timedScans: number;
  timedUnits: number;
  timedSeconds: number;
};

type Report = {
  people: { key: string; label: string }[];
  person: string;
  days: number;
  idleMinutes: number;
  totals: Totals;
  byKind: (Totals & { kind: ScanKind })[];
  stretches: {
    start: string;
    end: string;
    units: number;
    timedUnits: number;
    timedSeconds: number;
    scans: {
      at: string;
      kind: ScanKind;
      units: number;
      label: string;
      seconds: number | null;
    }[];
  }[];
};

const UNKNOWN_PERSON = "__unknown__";

const KIND_LABELS: Record<ScanKind, { label: string; tone: BadgeTone }> = {
  item: { label: "Single item", tone: "neutral" },
  multipack: { label: "Multipack", tone: "primary" },
  bundle: { label: "Bundle", tone: "purple" },
  damaged: { label: "Damaged/expired", tone: "danger" },
  dud: { label: "Dud", tone: "warning" },
};

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 0, label: "All time" },
];

const IDLE_CUTOFFS = [5, 10, 15, 20, 30];

// Owner-only (proxy.ts + the API route): how fast each person scans stock
// in, from the time between their saves. See src/lib/scanSpeed.ts for how
// breaks are kept out of the rate.
export default function ScanSpeedPage() {
  const [person, setPerson] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [idleMinutes, setIdleMinutes] = useState(10);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which filters the report on screen (or the last error) was for — it's
  // loading whenever that doesn't match the filters picked now.
  const filterKey = `${person}|${days}|${idleMinutes}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== filterKey;

  useEffect(() => {
    const params = new URLSearchParams({
      days: String(days),
      idle: String(idleMinutes),
    });
    if (person) params.set("person", person);
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
  }, [person, days, idleMinutes, filterKey]);

  const t = report?.totals;
  const unitsPerHour = t ? ratePerHour(t.timedUnits, t.timedSeconds) : null;
  const scansPerHour = t ? ratePerHour(t.timedScans, t.timedSeconds) : null;
  const personLabel = report?.people.find((p) => p.key === report.person)?.label ?? "";

  return (
    <AppShell title="Scan speed" subtitle="How fast stock gets scanned in, per person.">
      <div className="flex flex-col gap-6">
        <Card>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Person">
              <Select value={report?.person ?? person ?? ""} onChange={(e) => setPerson(e.target.value)}>
                {(report?.people ?? []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
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
            Each scan is timed from the previous save. A gap longer than the break cutoff is left out of the rate, so
            lunch or a phone call doesn&apos;t make the pace look slower.
          </p>
        </Card>

        {error && <Alert tone="danger">{error}</Alert>}

        {!report && loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" aria-hidden /> Loading…
          </div>
        )}

        {report && t && (
          <div className={cn("flex flex-col gap-6 transition-opacity", loading && "opacity-60")}>
            {report.person === UNKNOWN_PERSON && (
              <Alert tone="info">
                These were scanned before the app started recording who did the scanning, so they could be
                anyone&apos;s.
              </Alert>
            )}

            {t.scans === 0 ? (
              <Card className="py-10 text-center">
                <Timer className="mx-auto size-8 text-muted-foreground" aria-hidden />
                <p className="mt-2 font-medium text-foreground">No scans by {personLabel} in this range.</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Scans are credited to whoever is signed in on the scanner, starting Sep 25, 2026.
                </p>
              </Card>
            ) : (
              <>
                <section>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Stat
                      label="Units per hour"
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
                      label="Time scanning"
                      value={formatDuration(t.timedSeconds)}
                      hint={`${plural(t.units, "unit")} in ${plural(t.scans, "scan")}`}
                    />
                  </div>
                  {t.timedSeconds < 30 * 60 && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Only {formatDuration(t.timedSeconds)} of timed scanning so far, so treat the rate as rough. It
                      settles down as more gets scanned.
                    </p>
                  )}
                  {t.scans > t.timedScans && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {plural(t.scans - t.timedScans, "scan")} came right after a break with no fresh scan session to time them
                      from. They count in the totals, not the per-hour rate.
                    </p>
                  )}
                </section>

                {report.byKind.length > 1 && (
                  <Card padded={false}>
                    <div className="p-4 pb-0 sm:p-5 sm:pb-0">
                      <SectionHeader
                        title="By type of scan"
                        description="Bundles and multipacks usually take longer."
                      />
                    </div>
                    <ul className="divide-y divide-border">
                      {report.byKind.map((k) => (
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
                    title="Scanning stretches"
                    description="Back-to-back scans with no break. Tap one to see each scan."
                  />
                  <div className="flex flex-col gap-3">
                    {report.stretches.map((s) => (
                      <StretchCard key={s.start} stretch={s} />
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function StretchCard({ stretch: s }: { stretch: Report["stretches"][number] }) {
  const [open, setOpen] = useState(false);
  const rate = ratePerHour(s.timedUnits, s.timedSeconds);
  const start = new Date(s.start);
  const end = new Date(s.end);

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
            {plural(s.scans.length, "scan")} · {plural(s.units, "unit")}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-semibold tabular-nums text-foreground">{rate != null ? Math.round(rate) : "—"}</p>
          <p className="text-xs text-muted-foreground">units/hr</p>
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
                  <span className="text-xs text-muted-foreground">
                    {plural(scan.units, "unit")}
                  </span>
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

function projection(unitsPerHour: number): string {
  return `≈${Math.round(unitsPerHour * 4)} in 4 hrs · ${Math.round(unitsPerHour * 8)} in 8`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
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
