"use client";

import { Stat } from "@/components/Stat";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { useState } from "react";

// The sort station's count for a load (warehouse mode: the whole load is
// sorted into sort boxes before listing), next to the listing
// reconciliation, which stays as it was. Shows what the sorters physically
// found against the manifest: short, over, and extras that weren't on it.
// Money (the short units' cost/retail) only for the owner; the API leaves
// it out for employees.
//
// Consignment loads: expected is only what the pick list said to take, and
// what came anyway but goes back to the supplier is listed on its own.

export type SortStatus = {
  kind: "not_sorted" | "matches" | "short" | "over" | "left" | "going_back";
  units: number;
} | null;

export type SortingSummary = {
  sortedAt: string | null;
  sortedBy: string | null;
  expectedUnits: number;
  sortedGood: number;
  damaged: number;
  dud: number;
  short: number;
  over: number;
  extras: number;
  started: boolean;
  consignment?: boolean;
  // Consignment: set aside to go back to the supplier.
  returned?: number;
  returns?: { upc: string; description: string; units: number; notOnManifest: boolean; rxOnly?: boolean }[];
  shortCost?: number;
  shortRetail?: number;
};

export type SortLine = {
  id: string;
  upc: string | null;
  description: string;
  expectedQuantity: number;
  sortedGood?: number;
  sortStatus?: SortStatus;
};

const STATUS_TONE: Record<NonNullable<SortStatus>["kind"], BadgeTone> = {
  not_sorted: "neutral",
  matches: "success",
  short: "danger",
  over: "warning",
  left: "neutral",
  going_back: "warning",
};

export function sortStatusText(status: NonNullable<SortStatus>): string {
  if (status.kind === "not_sorted") return "Not sorted yet";
  if (status.kind === "matches") return "Matches";
  if (status.kind === "left") return "Left at supplier";
  if (status.kind === "going_back") return `Going back ${status.units}`;
  return status.kind === "short" ? `Short ${status.units}` : `Over ${status.units}`;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function SortingSection({
  sorting,
  lines,
  extras,
  isOwner,
}: {
  sorting: SortingSummary;
  lines: SortLine[];
  extras: { upc: string; units: number; name: string | null }[];
  isOwner: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const scannable = lines.filter((l) => l.sortStatus);
  const exceptions = scannable.filter((l) => l.sortStatus!.kind === "short" || l.sortStatus!.kind === "over");
  const shown = showAll ? scannable : exceptions;

  return (
    <section>
      <SectionHeader
        title="Sorting"
        description={
          sorting.sortedAt
            ? `Sorting finished ${new Date(sorting.sortedAt).toLocaleString()}${sorting.sortedBy ? ` by ${sorting.sortedBy}` : ""}.`
            : "Still sorting. Lines nobody has sorted yet show as not sorted, not short."
        }
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="Expected units" value={sorting.expectedUnits} />
        <Stat label="Sorted good" value={sorting.sortedGood} />
        <Stat label="Damaged/expired" value={sorting.damaged} />
        {sorting.consignment ? (
          <Stat label="Back to supplier" value={sorting.returned ?? 0} highlight={(sorting.returned ?? 0) > 0} />
        ) : (
          <Stat label="Dud" value={sorting.dud} />
        )}
        <Stat label="Short" value={sorting.short} highlight={sorting.short > 0} />
        <Stat label="Over" value={sorting.over} highlight={sorting.over > 0} />
        <Stat label="Extras" value={sorting.extras} highlight={sorting.extras > 0} />
        {isOwner && sorting.shortCost != null && (
          <Stat
            label="Short, cost"
            value={sorting.shortCost}
            format="currency"
            hint={sorting.shortRetail ? `${money(sorting.shortRetail)} retail` : undefined}
          />
        )}
      </div>

      <Card padded={false} className="mt-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-sm font-medium text-foreground">
            {exceptions.length === 0
              ? sorting.sortedAt
                ? "Every line matches."
                : "No short or over lines so far."
              : `${exceptions.length} ${exceptions.length === 1 ? "line is" : "lines are"} short or over`}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Only short and over" : "Show every line"}
          </Button>
        </div>
        {shown.length > 0 && (
          <ul className="divide-y divide-border text-sm">
            {shown.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-foreground">{l.description}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    UPC {l.upc} · expected {l.expectedQuantity} · sorted good {l.sortedGood ?? 0}
                  </p>
                </div>
                <Badge tone={STATUS_TONE[l.sortStatus!.kind]}>{sortStatusText(l.sortStatus!)}</Badge>
              </li>
            ))}
          </ul>
        )}
        {sorting.returns && sorting.returns.length > 0 && (
          <div className="border-t border-border px-4 py-3">
            <p className="mb-1 text-sm font-medium text-foreground">
              Going back to the supplier ({sorting.returned ?? 0} {sorting.returned === 1 ? "unit" : "units"})
            </p>
            <ul className="text-sm text-muted-foreground">
              {sorting.returns.map((r) => (
                <li key={`${r.upc}|${r.notOnManifest}|${r.rxOnly}`} className="tabular-nums">
                  {r.units} × {r.description}
                  {r.notOnManifest ? " (not on the manifest)" : ""}
                  {r.rxOnly ? " (Rx only, eBay won't allow it)" : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        {extras.length > 0 && (
          <div className="border-t border-border px-4 py-3">
            <p className="mb-1 text-sm font-medium text-foreground">Boxed but not on the manifest</p>
            <ul className="text-sm text-muted-foreground">
              {extras.map((e) => (
                <li key={e.upc} className="tabular-nums">
                  {e.units} × {e.name ?? "Name not found yet"} (UPC {e.upc})
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </section>
  );
}
