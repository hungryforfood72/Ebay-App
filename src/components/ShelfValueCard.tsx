"use client";

import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

type Bucket = { listings: number; units: number; cost: number; uncostedUnits: number };

type ShelfValue = Bucket & {
  listValue: number;
  unpricedUnits: number;
  byStatus: (Bucket & { status: string })[];
  byManifest: (Bucket & { manifestId: string | null; title: string })[];
};

const STATUS_LABELS: Record<string, string> = {
  pending_review: "Pending review",
  ready: "Ready to publish",
  exported: "Exported (CSV)",
  listed: "Listed on eBay",
};

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

// Owner only (the API route is too): cash tied up in unsold stock, at
// manifest COGS. Render it only for the owner, so an employee's browser
// never even asks.
export function ShelfValueCard() {
  const [value, setValue] = useState<ShelfValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/inventory/shelf-value")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Couldn't load shelf value.");
        setValue(data);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load shelf value."));
  }, []);

  return (
    <Card>
      <SectionHeader
        title="Cash on the shelf"
        description="What the stock you haven't sold yet cost you, using manifest COGS."
      />
      {error && <p className="text-sm font-medium text-danger">{error}</p>}
      {!value && !error && <p className="text-sm text-muted-foreground">Adding it up…</p>}
      {value && (
        <>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground">At cost</p>
              <p className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">{money(value.cost)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">At list price</p>
              <p className="text-xl font-semibold tabular-nums text-foreground">{money(value.listValue)}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {plural(value.units, "unit")} across {plural(value.listings, "listing")}
            </p>
          </div>

          {(value.uncostedUnits > 0 || value.unpricedUnits > 0) && (
            <ul className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
              {value.uncostedUnits > 0 && (
                <li>
                  {plural(value.uncostedUnits, "unit")} {value.uncostedUnits === 1 ? "has" : "have"} no cost yet
                  (no manifest, no landed cost entered, or a UPC that isn&apos;t on its manifest), so{" "}
                  {value.uncostedUnits === 1 ? "it counts" : "they count"} as $0.
                </li>
              )}
              {value.unpricedUnits > 0 && (
                <li>
                  {plural(value.unpricedUnits, "unit")}{" "}
                  {value.unpricedUnits === 1
                    ? "doesn't have a price yet and isn't"
                    : "don't have a price yet and aren't"}{" "}
                  in the list price.
                </li>
              )}
            </ul>
          )}

          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="-my-2 mt-2 flex items-center gap-1 py-2 text-sm font-medium text-primary"
          >
            {open ? "Hide breakdown" : "Show breakdown"}
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
          </button>

          {open && (
            <div className="mt-3 grid gap-5 md:grid-cols-2">
              <BreakdownList
                title="By stage"
                rows={value.byStatus.map((b) => ({ key: b.status, label: STATUS_LABELS[b.status] ?? b.status, ...b }))}
              />
              <BreakdownList
                title="By load"
                rows={value.byManifest.map((b) => ({ key: b.manifestId ?? "none", label: b.title, ...b }))}
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function BreakdownList({ title, rows }: { title: string; rows: (Bucket & { key: string; label: string })[] }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((r) => (
          <li key={r.key} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="truncate text-foreground">{r.label}</p>
              <p className="text-xs text-muted-foreground">
                {plural(r.units, "unit")}
                {r.uncostedUnits > 0 && ` · ${r.uncostedUnits.toLocaleString()} with no cost`}
              </p>
            </div>
            <p className="shrink-0 font-medium tabular-nums text-foreground">{money(r.cost)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
