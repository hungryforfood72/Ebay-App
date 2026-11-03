"use client";

import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Field, Select } from "@/components/ui/Input";
import type { SortCountFixRow, SortCountPerson } from "@/lib/warehouse/sortCountReport";
import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

// "Count was off" fixes from the gather and List pages (Cristian,
// 2026-11-02): a box that held fewer than the sort said is units that went
// missing between the sort and the gather. By sorter (against how much they
// sorted), by who reported it, and every fix, so a pattern stands out.

type Report = { days: number; sorters: SortCountPerson[]; fixers: SortCountPerson[]; fixes: SortCountFixRow[] };

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 365, label: "Last year" },
];

function shortRate(p: SortCountPerson): string {
  if (p.sortedUnits === 0) return "—";
  const per100 = (p.shortUnits / p.sortedUnits) * 100;
  return per100 === 0 ? "0" : per100 < 0.1 ? "<0.1" : per100.toFixed(1);
}

export default function SortCountsPage() {
  const [days, setDays] = useState(90);
  const [report, setReport] = useState<{ days: number; data: Report } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = report?.days !== days;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/reports/sort-counts?days=${days}`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error ?? "Couldn't load the report.");
        return data as Report;
      })
      .then((data) => {
        if (cancelled) return;
        setReport({ days, data });
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load the report."));
    return () => {
      cancelled = true;
    };
  }, [days]);

  const data = report?.data;

  return (
    <AppShell title="Sort counts" subtitle="Boxes that held more or fewer than the sort said, and who sorted them.">
      <div className="flex flex-col gap-6">
        <Card>
          <Field label="Range">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {RANGES.map((r) => (
                <option key={r.days} value={r.days}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
        </Card>

        {error && <Alert tone="danger">{error}</Alert>}
        {loading && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading…
          </p>
        )}

        {data && !loading && (
          <>
            <PeopleCard
              title="By who sorted it"
              description="Short = the box held fewer than they logged. Short per 100 is against everything they sorted in this range."
              people={data.sorters}
              showSorted
            />
            <PeopleCard
              title="By who found it"
              description="Who fixed the count while gathering or listing."
              people={data.fixers}
            />
            <FixesCard fixes={data.fixes} />
          </>
        )}
      </div>
    </AppShell>
  );
}

function PeopleCard({
  title,
  description,
  people,
  showSorted = false,
}: {
  title: string;
  description: string;
  people: SortCountPerson[];
  showSorted?: boolean;
}) {
  return (
    <Card padded={false}>
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <SectionHeader title={title} description={description} />
      </div>
      {people.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground sm:px-5 sm:pb-5">Nothing in this range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium sm:px-5">Person</th>
                {showSorted && <th className="px-3 py-2 text-right font-medium">Units sorted</th>}
                <th className="px-3 py-2 text-right font-medium">Fixes</th>
                <th className="px-3 py-2 text-right font-medium">Units short</th>
                <th className="px-3 py-2 text-right font-medium">Units over</th>
                <th className="px-3 py-2 text-right font-medium">Loads short</th>
                {showSorted && <th className="px-4 py-2 text-right font-medium sm:px-5">Short per 100</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {people.map((p) => (
                <tr key={p.person}>
                  <td className="px-4 py-2.5 font-medium text-foreground sm:px-5">{p.person}</td>
                  {showSorted && <td className="px-3 py-2.5 text-right tabular-nums">{p.sortedUnits}</td>}
                  <td className="px-3 py-2.5 text-right tabular-nums">{p.fixes}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {p.shortUnits > 0 ? <span className="font-semibold text-danger">{p.shortUnits}</span> : 0}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{p.overUnits}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{p.loadsShort}</td>
                  {showSorted && <td className="px-4 py-2.5 text-right tabular-nums sm:px-5">{shortRate(p)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function FixesCard({ fixes }: { fixes: SortCountFixRow[] }) {
  return (
    <Card padded={false}>
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <SectionHeader title={`Every fix (${fixes.length})`} description="Newest first." />
      </div>
      {fixes.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground sm:px-5 sm:pb-5">No counts fixed in this range.</p>
      ) : (
        <ul className="divide-y divide-border">
          {fixes.map((f) => {
            const diff = f.foundCount - f.sortedCount;
            return (
              <li key={f.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm sm:px-5">
                <div className="min-w-0">
                  <p className="line-clamp-2 font-medium text-foreground">{f.product}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {f.box} ·{" "}
                    <Link href={`/manifests/${f.manifestId}`} className="underline">
                      {f.load}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Sorted by {f.sortedBy ?? "(not recorded)"} · found by {f.fixedBy ?? "(not recorded)"} on the{" "}
                    {f.page === "list" ? "List" : "Gather"} page ·{" "}
                    {new Date(f.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <Badge tone={diff < 0 ? "danger" : "warning"}>{diff < 0 ? `${-diff} short` : `${diff} over`}</Badge>
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    {f.sortedCount} → {f.foundCount}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
