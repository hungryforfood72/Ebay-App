"use client";

import { Stat } from "@/components/Stat";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Field, Select } from "@/components/ui/Input";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Outcome = {
  id: string;
  manifestId: string;
  manifestTitle: string;
  upc: string;
  description: string;
  evaluatedAt: string;
  dataConfidence: string;
  sellRateSource: string | null;
  predictedDud: boolean;
  predictedUnitPrice: number | null;
  predictedUnitsPerMonth: number | null;
  expectedUnits: number;
  listedUnits: number;
  soldUnits: number;
  dudUnits: number;
  actualUnitPrice: number | null;
  actualNetPerUnit: number | null;
  monthsActive: number | null;
  actualUnitsPerMonth: number | null;
  priceRatio: number | null;
  speedRatio: number | null;
};

type Report = {
  calibration: { kind: string; factor: number; rawMedian: number; sampleSize: number; updatedAt: string }[];
  lessons: { notes: string; updatedAt: string } | null;
  outcomes: Outcome[];
};

type Filter = "all" | "sold" | "dud_sold" | "stuck" | "waiting";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "sold", label: "Has sales" },
  { value: "dud_sold", label: "Called a dud, sold anyway" },
  { value: "stuck", label: "Expected to sell, nothing yet" },
  { value: "waiting", label: "Not listed yet" },
  { value: "all", label: "Everything" },
];

// Same minimum the tracker uses before a correction kicks in
// (MIN_CALIBRATION_SAMPLE in src/lib/predictionTracker.ts).
const MIN_SAMPLE = 8;

function matches(o: Outcome, filter: Filter) {
  if (filter === "sold") return o.soldUnits > 0;
  if (filter === "dud_sold") return o.predictedDud && o.soldUnits > 0;
  if (filter === "stuck") return !o.predictedDud && o.listedUnits > 0 && o.soldUnits === 0 && (o.monthsActive ?? 0) >= 1;
  if (filter === "waiting") return o.listedUnits === 0 && o.soldUnits === 0;
  return true;
}

// "+12%" / "-30%" for an actual/guessed ratio.
function pctOff(ratio: number | null) {
  if (ratio == null) return null;
  const pct = Math.round((ratio - 1) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function ratioTone(ratio: number | null) {
  if (ratio == null) return "neutral" as const;
  if (ratio >= 0.85 && ratio <= 1.15) return "success" as const;
  return ratio < 1 ? ("danger" as const) : ("primary" as const);
}

function money(n: number | null) {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

function perMonth(n: number | null) {
  return n == null ? "—" : `${n < 10 ? n.toFixed(1) : Math.round(n)}/mo`;
}

function correctionText(c: Report["calibration"][number] | undefined, label: string) {
  if (!c || c.sampleSize === 0) return { value: "None yet", hint: `No ${label} results to learn from yet` };
  if (c.sampleSize < MIN_SAMPLE)
    return {
      value: "None yet",
      hint: `${c.sampleSize} of ${MIN_SAMPLE} products needed (so far real is ${pctOff(c.rawMedian)} vs guessed)`,
    };
  return {
    value: c.factor === 1 ? "×1.00" : `×${c.factor.toFixed(2)}`,
    hint: `From ${c.sampleSize} products, real ${pctOff(c.rawMedian)} vs guessed`,
  };
}

async function fetchReport(): Promise<Report> {
  const res = await fetch("/api/reports/analyzer-accuracy");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Couldn't load the report.");
  return data as Report;
}

// Owner-only (proxy.ts + the API route): the Analyzer's guesses on bought
// loads next to what really happened, and what it's learned from that.
// See src/lib/predictionTracker.ts.
export default function AnalyzerAccuracyPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("sold");
  const [manifestId, setManifestId] = useState("all");

  useEffect(() => {
    let cancelled = false;
    fetchReport()
      .then((data) => !cancelled && setReport(data))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load the report."));
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/reports/analyzer-accuracy", { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Refresh failed.");
      setReport(await fetchReport());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }

  const manifests = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of report?.outcomes ?? []) seen.set(o.manifestId, o.manifestTitle);
    return [...seen.entries()];
  }, [report]);

  const outcomes = report?.outcomes ?? [];
  const shown = outcomes.filter((o) => (manifestId === "all" || o.manifestId === manifestId) && matches(o, filter));
  const withSales = outcomes.filter((o) => o.soldUnits > 0).length;
  const dudCalls = outcomes.filter((o) => o.predictedDud && o.listedUnits + o.soldUnits > 0);
  const dudsThatSold = dudCalls.filter((o) => o.soldUnits > 0).length;
  const price = correctionText(report?.calibration.find((c) => c.kind === "price"), "price");
  const speed = correctionText(report?.calibration.find((c) => c.kind === "speed"), "sell-speed");

  return (
    <AppShell
      title="Analyzer accuracy"
      subtitle="What the Analyzer guessed on loads you bought, next to what really happened."
      actions={
        <Button variant="secondary" size="sm" onClick={refresh} disabled={refreshing}>
          {refreshing ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          Refresh now
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {error && <Alert tone="danger">{error}</Alert>}
        {!report && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading…
          </div>
        )}

        {report && (
          <>
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Products tracked" value={outcomes.length} hint={`${withSales} with sales so far`} />
              <Stat label="Price correction" value={price.value} hint={price.hint} />
              <Stat label="Sell-speed correction" value={speed.value} hint={speed.hint} />
              <Stat
                label="Dud calls that sold"
                value={dudCalls.length ? `${dudsThatSold} of ${dudCalls.length}` : "—"}
                hint="Called a dud, but you listed it and it sold"
              />
            </section>

            <Card>
              <SectionHeader
                title="What it's learned"
                description="Updated every 4 hours as sales come in. The Analyzer reads this when explaining new calls, and the corrections above change its numbers once enough products have sold."
              />
              <p className="whitespace-pre-line text-sm text-foreground">
                {report.lessons?.notes ??
                  "Nothing yet. Once units from a bought load start selling, this fills in with where the Analyzer runs high or low."}
              </p>
            </Card>

            <Card padded={false}>
              <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
                <Field label="Show">
                  <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                    {FILTERS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Load">
                  <Select value={manifestId} onChange={(e) => setManifestId(e.target.value)}>
                    <option value="all">All bought loads</option>
                    {manifests.map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {shown.length === 0 ? (
                <p className="px-4 pb-5 text-sm text-muted-foreground sm:px-5">Nothing matches.</p>
              ) : (
                <ul className="divide-y divide-border border-t border-border">
                  {shown.map((o) => (
                    <li key={o.id} className="px-4 py-3 sm:px-5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-foreground">{o.description}</p>
                          <p className="text-xs text-muted-foreground">
                            {o.manifestTitle} · guessed {new Date(o.evaluatedAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {o.predictedDud && <Badge tone="warning">called a dud</Badge>}
                          <Badge tone="neutral">
                            {o.soldUnits} sold of {o.listedUnits} listed
                            {o.dudUnits > 0 ? ` · ${o.dudUnits} set aside` : ""}
                          </Badge>
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <p className="text-xs text-muted-foreground">Price per unit (eBay)</p>
                          <p className="tabular-nums">
                            {money(o.predictedUnitPrice)} guessed → {money(o.actualUnitPrice)} real{" "}
                            {o.priceRatio != null && <Badge tone={ratioTone(o.priceRatio)}>{pctOff(o.priceRatio)}</Badge>}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Sell speed</p>
                          <p className={cn("tabular-nums", o.predictedUnitsPerMonth == null && "text-muted-foreground")}>
                            {o.predictedUnitsPerMonth == null
                              ? "No speed guess"
                              : `${perMonth(o.predictedUnitsPerMonth)} guessed`}{" "}
                            → {o.actualUnitsPerMonth != null ? `${perMonth(o.actualUnitsPerMonth)} real` : "too early"}{" "}
                            {o.speedRatio != null && <Badge tone={ratioTone(o.speedRatio)}>{pctOff(o.speedRatio)}</Badge>}
                          </p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
