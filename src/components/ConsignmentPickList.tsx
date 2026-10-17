"use client";

import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/Input";
import { ChevronDown, Download, ScanBarcode } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

// Mirrors ConsignmentPickList in src/lib/consignment.ts.
export type ConsignmentPick = {
  estimateId: string;
  upc: string | null;
  itemNumbers: string[];
  description: string;
  availableUnits: number;
  takeUnits: number;
  piecesPerUnit: number | null;
  netPerUnit: number | null;
  yourSharePerUnit: number | null;
  monthsToSellThrough: number | null;
  reason: string;
};

export type ConsignmentPickListData = {
  supplierPct: number;
  picks: ConsignmentPick[];
  skipped: ConsignmentPick[];
  takeUnits: number;
  yourProfit: number;
  supplierPayout: number;
};

// Consignment on/off and the supplier's share of profit (after eBay fees
// and the label). Saving reloads the page data, which rebuilds the pick
// list server-side from the existing evaluation, no re-run.
export function ConsignmentTermsCard({
  manifestId,
  consignment,
  supplierPct,
  onSaved,
}: {
  manifestId: string;
  consignment: boolean;
  supplierPct: number;
  onSaved: () => void;
}) {
  const [pct, setPct] = useState(String(supplierPct));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: { consignment?: boolean; consignmentSupplierPct?: number }) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/manifests/${manifestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't save.");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Consignment"
        description="Pay the supplier only when something sells, pick what you want, and give back what doesn't sell. Shows a pick list instead of a max bid."
      />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={consignment}
            disabled={saving}
            onChange={(e) => save({ consignment: e.target.checked })}
          />
          This load is on consignment
        </label>
        {consignment && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="supplier-pct" className="text-sm text-muted-foreground">
              Supplier gets
            </label>
            <div className="relative w-24">
              <Input
                id="supplier-pct"
                type="number"
                min={0}
                max={100}
                step={5}
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className="pr-7"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground">
                %
              </span>
            </div>
            <span className="text-sm text-muted-foreground">of profit after eBay fees and the label</span>
            <Button
              size="sm"
              variant="outline"
              disabled={saving || pct === "" || Number(pct) === supplierPct}
              onClick={() => save({ consignmentSupplierPct: Number(pct) })}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-sm font-medium text-danger">{error}</p>}
    </Card>
  );
}

function units(p: ConsignmentPick, n: number) {
  if (p.piecesPerUnit && p.piecesPerUnit > 1) return `${n} box${n === 1 ? "" : "es"} (${n * p.piecesPerUnit} pcs)`;
  return String(n);
}

function csvCell(v: string | number | null) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(list: ConsignmentPickListData, title: string) {
  const header = ["Item #", "UPC", "Description", "Take", "Pieces", "Available", "Your share per unit", "Why"];
  const rows = list.picks.map((p) => [
    p.itemNumbers.join(" / "),
    p.upc,
    p.description,
    p.takeUnits,
    p.piecesPerUnit ? p.takeUnits * p.piecesPerUnit : p.takeUnits,
    p.availableUnits,
    p.yourSharePerUnit != null ? p.yourSharePerUnit.toFixed(2) : "",
    p.reason,
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[^\w-]+/g, "_")}_pick_list.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// What to take from a consignment load (src/lib/consignment.ts).
export function ConsignmentPickListView({
  list,
  title,
  manifestId,
}: {
  list: ConsignmentPickListData;
  title: string;
  manifestId: string;
}) {
  const [showSkipped, setShowSkipped] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <PickStat label="Products to take" value={`${list.picks.length}`} hint={`of ${list.picks.length + list.skipped.length}`} />
        <PickStat label="Units to take" value={`${list.takeUnits}`} />
        <PickStat label="Your est. profit" value={`$${list.yourProfit.toFixed(0)}`} emphasis />
        <PickStat label={`Supplier's ${list.supplierPct}%`} value={`$${list.supplierPayout.toFixed(0)}`} hint="paid as things sell" />
      </dl>
      <p className="text-xs text-muted-foreground">
        Estimates from current eBay asking prices, after eBay fees and a label. Anything that doesn&apos;t sell goes back, so
        trial amounts are for items with no sell-speed data yet.
      </p>

      {list.picks.length === 0 ? (
        <Alert tone="info">Nothing here clears the bar at this split.</Alert>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Link href={`/pick/${manifestId}`} className={buttonClasses({ size: "sm" })}>
              <ScanBarcode className="size-4" aria-hidden />
              Scan to pick (take / leave)
            </Link>
            <Button variant="outline" size="sm" onClick={() => downloadCsv(list, title)}>
              <Download className="size-4" aria-hidden />
              Download pick list
            </Button>
          </div>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {list.picks.map((p) => (
              <PickRow key={p.estimateId} pick={p} />
            ))}
          </ul>
        </>
      )}

      {list.skipped.length > 0 && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setShowSkipped((v) => !v)} className="-ml-2">
            <ChevronDown className={cn("size-4 transition-transform", showSkipped && "rotate-180")} aria-hidden />
            {showSkipped ? "Hide" : "Show"} {list.skipped.length} to leave behind
          </Button>
          {showSkipped && (
            <ul className="mt-2 divide-y divide-border rounded-xl border border-border text-muted-foreground">
              {list.skipped.map((p) => (
                <PickRow key={p.estimateId} pick={p} skipped />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function PickRow({ pick: p, skipped = false }: { pick: ConsignmentPick; skipped?: boolean }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium leading-snug", !skipped && "text-foreground")}>{p.description}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {p.itemNumbers.length > 0 ? `Item # ${p.itemNumbers.join(" / ")} · ` : ""}
          {p.reason}
        </p>
      </div>
      {!skipped && (
        <div className="shrink-0 text-right">
          <Badge tone="success">Take {units(p, p.takeUnits)}</Badge>
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
            {p.takeUnits < p.availableUnits ? `of ${p.availableUnits} · ` : ""}
            {p.yourSharePerUnit != null ? `$${p.yourSharePerUnit.toFixed(2)}/unit to you` : ""}
          </p>
        </div>
      )}
    </li>
  );
}

function PickStat({ label, value, hint, emphasis }: { label: string; value: string; hint?: string; emphasis?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 font-semibold tabular-nums text-foreground", emphasis ? "text-xl text-success" : "text-lg")}>
        {value}
      </dd>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
