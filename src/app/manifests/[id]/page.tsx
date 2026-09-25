"use client";

import { Stat } from "@/components/Stat";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input, Select } from "@/components/ui/Input";
import { useCurrentUser } from "@/components/UserNav";
import { Pencil, ScanBarcode } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, use as usePromise } from "react";

// retailPrice/extendedRetail/weightedCogsPerUnit/soldRevenue/soldFees/profit
// are all financial fields the API omits for an employee (see
// /api/manifests/[id]'s isOwner gating) — optional here so the page can
// render a reduced view for them instead of crashing on an undefined field.
type Line = {
  id: string;
  supplierSku: string | null;
  upc: string | null;
  description: string;
  expectedQuantity: number;
  retailPrice?: number;
  extendedRetail?: number;
  condition: string | null;
  category: string | null;
  subcategory: string | null;
  receivedUnits: number;
  damagedUnits: number;
  dudUnits: number;
  accountedUnits: number;
  missingUnits: number;
  weightedCogsPerUnit?: number | null;
  soldUnits: number;
  soldRevenue?: number;
  soldFees?: number;
  profit?: number | null;
};

type SourcingLineEstimate = {
  id: string;
  upc: string | null;
  description: string;
  extendedRetail: number;
  estimatedUnitSalePrice: number | null;
  estimatedNetPerUnit: number | null;
  effectiveUnits: number;
  dataConfidence: string;
  flaggedDud: boolean;
};

type SourcingEvaluation = {
  id: string;
  status: "running" | "complete" | "failed";
  recommendation: "buy" | "dont_buy" | null;
  maxBid: number | null;
  expectedNetContribution: number | null;
  reasoning: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  lineEstimates: SourcingLineEstimate[];
};

type ManifestDetail = {
  id: string;
  title: string;
  supplier: string;
  totalLandedCost?: number | null;
  createdAt: string;
  lines: Line[];
  unmatchedReceived: { upc: string | null; units: number }[];
  unmatchedDamaged: { upc: string | null; units: number }[];
  unmatchedDud: { upc: string | null; units: number }[];
  unmatchedSold: { upc: string | null; units: number; revenue?: number; fees?: number }[];
  sourcingEvaluation?: SourcingEvaluation | null;
  summary: {
    totalExpectedUnits: number;
    totalReceivedUnits: number;
    totalDamagedUnits: number;
    totalDudUnits: number;
    totalAccountedUnits: number;
    totalMissingUnits: number;
    totalManifestExtendedRetail?: number;
    blendedCogsPerUnit?: number | null;
    totalSoldUnits: number;
    totalSoldRevenue?: number;
    totalSoldFees?: number;
    totalProfit?: number;
    totalListedUnsoldItems: number;
  };
};

export default function ManifestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [manifest, setManifest] = useState<ManifestDetail | null>(null);
  const [landedCostInput, setLandedCostInput] = useState("");
  const [savingCost, setSavingCost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [discountMode, setDiscountMode] = useState<"percent" | "amount">("percent");
  const [discountValue, setDiscountValue] = useState("");
  const [applyingDiscount, setApplyingDiscount] = useState(false);
  const [discountResult, setDiscountResult] = useState<string | null>(null);

  function load() {
    fetch(`/api/manifests/${id}`)
      .then((r) => r.json())
      .then((data: ManifestDetail) => {
        setManifest(data);
        setLandedCostInput(data.totalLandedCost != null ? String(data.totalLandedCost) : "");
        setTitleInput(data.title);
      });
  }

  useEffect(load, [id]);

  async function saveTitle() {
    const trimmed = titleInput.trim();
    if (!trimmed) return;
    setSavingTitle(true);
    setError(null);
    try {
      const res = await fetch(`/api/manifests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) throw new Error("Failed to rename.");
      setEditingTitle(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSavingTitle(false);
    }
  }

  async function saveLandedCost() {
    setSavingCost(true);
    setError(null);
    try {
      const res = await fetch(`/api/manifests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalLandedCost: landedCostInput || null }),
      });
      if (!res.ok) throw new Error("Failed to save.");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSavingCost(false);
    }
  }

  // Manual, human-triggered action — not automatic on any profit threshold.
  // Discounts every currently-"listed" (published, not sold) item in this
  // manifest relative to its own current price, not one shared target
  // price, since a manifest's items are rarely priced the same to begin
  // with.
  async function applyDiscount() {
    const value = Number(discountValue);
    if (!value || value <= 0) return;
    const count = manifest?.summary.totalListedUnsoldItems ?? 0;
    if (count === 0) return;
    const label = discountMode === "percent" ? `${value}% off` : `$${value.toFixed(2)} off`;
    if (
      !confirm(
        `Apply ${label} to all ${count} listed, unsold item(s) in this manifest? This changes real live eBay prices and isn't easily undone.`
      )
    ) {
      return;
    }
    setApplyingDiscount(true);
    setDiscountResult(null);
    try {
      const res = await fetch(`/api/manifests/${id}/discount`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: discountMode, value }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Discount failed.");
      setDiscountResult(
        result.failed.length > 0
          ? `Updated ${result.updated} of ${result.updated + result.failed.length}. Failed: ${result.failed
              .map((f: { title: string }) => f.title)
              .join(", ")}`
          : `Updated ${result.updated} item(s).`
      );
      load();
    } catch (e) {
      setDiscountResult(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setApplyingDiscount(false);
    }
  }

  const user = useCurrentUser();
  const isOwner = user?.role === "owner";

  if (!manifest) {
    return (
      <AppShell title="Manifest">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    );
  }

  const s = manifest.summary;
  const evaluation = manifest.sourcingEvaluation;
  const hasUnmatched =
    manifest.unmatchedReceived.length > 0 ||
    manifest.unmatchedDamaged.length > 0 ||
    manifest.unmatchedDud.length > 0 ||
    manifest.unmatchedSold.length > 0;

  return (
    <AppShell
      title={
        editingTitle ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-full max-w-md">
              <Input
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") {
                    setEditingTitle(false);
                    setTitleInput(manifest.title);
                  }
                }}
                aria-label="Manifest title"
                autoFocus
              />
            </div>
            <Button size="sm" onClick={saveTitle} disabled={savingTitle || !titleInput.trim()}>
              {savingTitle ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditingTitle(false);
                setTitleInput(manifest.title);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-x-2">
            {manifest.title}
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              aria-label="Rename manifest"
              title="Rename"
              className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil className="size-4" aria-hidden />
            </button>
          </span>
        )
      }
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-x-2">
          <Link href="/manifests" className="font-medium text-primary hover:underline">
            All manifests
          </Link>
          <span aria-hidden>·</span>
          {new Date(manifest.createdAt).toLocaleDateString()}
          <span aria-hidden>·</span>
          {manifest.lines.length} line items
        </span>
      }
      actions={
        <Link href={`/scan?manifestId=${manifest.id}`} className={buttonClasses({ size: "lg" })}>
          <ScanBarcode className="size-5" aria-hidden />
          Scan into this manifest
        </Link>
      }
    >
      <div className="flex flex-col gap-6">
        <section>
          <SectionHeader title="Reconciliation" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Expected units" value={s.totalExpectedUnits} />
            <Stat label="Received" value={s.totalReceivedUnits} />
            <Stat label="Damaged/expired" value={s.totalDamagedUnits} />
            <Stat label="Dud/unsellable" value={s.totalDudUnits} />
            <Stat label="Missing" value={s.totalMissingUnits} highlight={s.totalMissingUnits !== 0} />
            <Stat label="Sold units" value={s.totalSoldUnits} />
          </div>
        </section>

        {isOwner && (s.totalSoldRevenue != null || s.totalSoldFees != null || s.totalProfit != null) && (
          <section>
            <SectionHeader title="Sales" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {s.totalSoldRevenue != null && <Stat label="Sold revenue" value={s.totalSoldRevenue} format="currency" />}
              {s.totalSoldFees != null && <Stat label="Sold fees" value={s.totalSoldFees} format="currency" />}
              {s.totalProfit != null && (
                <Stat
                  label="Profit"
                  value={s.totalProfit}
                  format="currency"
                  highlight={s.totalSoldUnits > 0 && s.totalProfit < 0}
                />
              )}
            </div>
          </section>
        )}

        {isOwner && evaluation?.status === "complete" && (
          <Card>
            <SectionHeader
              title="Pre-purchase estimate"
              description="From the Analyzer, before this was purchased — read-only."
              action={
                <Badge tone={evaluation.recommendation === "buy" ? "success" : "danger"} size="lg">
                  {evaluation.recommendation === "buy" ? "Buy" : "Don't buy"}
                </Badge>
              }
            />
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Predicted max bid" value={evaluation.maxBid != null ? `$${evaluation.maxBid.toFixed(2)}` : "—"} />
              {evaluation.maxBid != null && evaluation.expectedNetContribution != null && (
                <Metric
                  label="Predicted profit at that bid"
                  value={`$${(evaluation.expectedNetContribution - evaluation.maxBid).toFixed(2)}`}
                />
              )}
              {/* Once the real landed cost is known (entered below), it's
                  almost always different from the pre-purchase max-bid
                  estimate — this reflects the same expected revenue against
                  what was actually paid, not the earlier guess, so profit/ROI
                  stay accurate after the fact. This is also the real
                  predicted-vs-actual comparison point the sourcing agent's
                  learning loop is meant to build toward. */}
              {manifest.totalLandedCost != null && evaluation.expectedNetContribution != null && (
                <>
                  <Metric
                    label="Est. profit at actual cost"
                    value={`$${(evaluation.expectedNetContribution - manifest.totalLandedCost).toFixed(2)}`}
                  />
                  <Metric
                    label="Est. ROI at actual cost"
                    value={
                      manifest.totalLandedCost > 0
                        ? `${(
                            ((evaluation.expectedNetContribution - manifest.totalLandedCost) / manifest.totalLandedCost) *
                            100
                          ).toFixed(0)}%`
                        : "—"
                    }
                  />
                </>
              )}
            </dl>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {isOwner && (
            <Card>
              <SectionHeader title="Total landed cost" description="What this whole load actually cost you, delivered." />
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">
                    $
                  </span>
                  <Input
                    size="sm"
                    type="number"
                    step="0.01"
                    value={landedCostInput}
                    onChange={(e) => setLandedCostInput(e.target.value)}
                    placeholder="1200.00"
                    aria-label="Total landed cost"
                    className="pl-7"
                  />
                </div>
                <Button onClick={saveLandedCost} disabled={savingCost}>
                  Save
                </Button>
              </div>
              {error && <p className="mt-2 text-sm font-medium text-danger">{error}</p>}
              {s.blendedCogsPerUnit != null ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  Blended COGS:{" "}
                  <strong className="text-foreground">${s.blendedCogsPerUnit.toFixed(4)}</strong> per unit (landed cost ÷{" "}
                  {s.totalReceivedUnits} units received). Per-line weighted cost below accounts for each item&apos;s
                  share of the load&apos;s declared value, divided by that line&apos;s good units received —
                  damaged/expired and still-missing units aren&apos;t counted.
                </p>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">Enter a landed cost to see COGS per unit.</p>
              )}
            </Card>
          )}

          <Card>
            <SectionHeader
              title="Bulk discount"
              description={`${s.totalListedUnsoldItems} item(s) still listed and unsold. Applied relative to each item's own current price, not one shared price.`}
            />
            <div className="flex gap-2">
              <div className="w-28 shrink-0">
                <Select
                  size="sm"
                  value={discountMode}
                  onChange={(e) => setDiscountMode(e.target.value as "percent" | "amount")}
                  aria-label="Discount type"
                >
                  <option value="percent">% off</option>
                  <option value="amount">$ off</option>
                </Select>
              </div>
              <Input
                size="sm"
                type="number"
                step="0.01"
                min={0}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                placeholder={discountMode === "percent" ? "15" : "5.00"}
                aria-label="Discount amount"
                className="min-w-0"
              />
              <Button
                onClick={applyDiscount}
                disabled={applyingDiscount || !discountValue || s.totalListedUnsoldItems === 0}
                className="shrink-0"
              >
                {applyingDiscount ? "Applying…" : "Apply"}
              </Button>
            </div>
            {discountResult && <p className="mt-3 text-sm text-muted-foreground">{discountResult}</p>}
          </Card>
        </div>

        {hasUnmatched && (
          <Alert tone="warning" title="Scanned items not on this manifest">
            <ul className="flex flex-col gap-1">
              {manifest.unmatchedReceived.map((u) => (
                <li key={`r-${u.upc}`}>
                  Received {u.units} unit(s) of UPC {u.upc ?? "(none)"} — not on the manifest.
                </li>
              ))}
              {manifest.unmatchedDamaged.map((u) => (
                <li key={`d-${u.upc}`}>
                  Marked {u.units} unit(s) damaged for UPC {u.upc} — not on the manifest.
                </li>
              ))}
              {manifest.unmatchedDud.map((u) => (
                <li key={`x-${u.upc}`}>
                  Marked {u.units} unit(s) dud/unsellable for UPC {u.upc} — not on the manifest.
                </li>
              ))}
              {manifest.unmatchedSold.map((u) => (
                <li key={`s-${u.upc}`}>
                  Sold {u.units} unit(s) of UPC {u.upc ?? "(none)"}
                  {isOwner && u.revenue != null ? ` ($${u.revenue.toFixed(2)} revenue)` : ""} — not on the manifest.
                </li>
              ))}
            </ul>
          </Alert>
        )}

        <section>
          <SectionHeader title="Line items" action={<Badge>{manifest.lines.length}</Badge>} />

          {/* Phones: one card per line — ten numeric columns can't fit a
              ~360px screen, and a sideways-scrolling table is miserable on
              the scanner. The full table takes over from md up. */}
          <ul className="flex flex-col gap-2 md:hidden">
            {manifest.lines.map((line) => {
              const complete = line.expectedQuantity > 0 && line.receivedUnits >= line.expectedQuantity;
              return (
                <li key={line.id} className="rounded-xl border border-border bg-surface p-3 shadow-sm">
                  <p className="font-medium leading-snug text-foreground">{line.description}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                    {line.upc ?? "no UPC"}
                    {isOwner && line.retailPrice != null ? ` · $${line.retailPrice.toFixed(2)} retail` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone={complete ? "success" : "neutral"}>
                      Received {line.receivedUnits}/{line.expectedQuantity}
                    </Badge>
                    {line.missingUnits !== 0 && <Badge tone="danger">Missing {line.missingUnits}</Badge>}
                    {line.damagedUnits > 0 && <Badge tone="warning">Damaged {line.damagedUnits}</Badge>}
                    {line.dudUnits > 0 && <Badge tone="warning">Dud {line.dudUnits}</Badge>}
                    {line.soldUnits > 0 && <Badge tone="primary">Sold {line.soldUnits}</Badge>}
                  </div>
                  {isOwner && (
                    <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                      <span>COGS {line.weightedCogsPerUnit != null ? `$${line.weightedCogsPerUnit.toFixed(4)}` : "—"}</span>
                      <span>Revenue {line.soldRevenue != null ? `$${line.soldRevenue.toFixed(2)}` : "—"}</span>
                      <span className={cn(line.profit != null && line.profit < 0 && "font-semibold text-danger")}>
                        Profit {line.profit != null ? `$${line.profit.toFixed(2)}` : "—"}
                      </span>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>

          <Card padded={false} className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-background">
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th className="px-4 py-3">Item</th>
                    <th className="px-3 py-3 text-right">Expected</th>
                    <th className="px-3 py-3 text-right">Received</th>
                    <th className="px-3 py-3 text-right">Damaged</th>
                    <th className="px-3 py-3 text-right">Dud</th>
                    <th className="px-3 py-3 text-right">Missing</th>
                    {isOwner && <th className="px-3 py-3 text-right">COGS/unit</th>}
                    <th className="px-3 py-3 text-right">Sold</th>
                    {isOwner && <th className="px-3 py-3 text-right">Revenue</th>}
                    {isOwner && <th className="px-4 py-3 text-right">Profit</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border tabular-nums">
                  {manifest.lines.map((line) => (
                    <tr key={line.id} className="hover:bg-background">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-foreground">{line.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {line.upc ?? "no UPC"}
                          {isOwner && line.retailPrice != null ? ` · $${line.retailPrice.toFixed(2)} retail` : ""}
                        </p>
                      </td>
                      <td className="px-3 text-right">{line.expectedQuantity}</td>
                      <td className="px-3 text-right">
                        <span
                          className={cn(
                            line.expectedQuantity > 0 &&
                              line.receivedUnits >= line.expectedQuantity &&
                              "rounded-md bg-green-50 px-1.5 py-0.5 font-medium text-green-700"
                          )}
                        >
                          {line.receivedUnits}
                        </span>
                      </td>
                      <td className="px-3 text-right">{line.damagedUnits}</td>
                      <td className="px-3 text-right">{line.dudUnits}</td>
                      <td className={cn("px-3 text-right", line.missingUnits !== 0 && "font-semibold text-danger")}>
                        {line.missingUnits}
                      </td>
                      {isOwner && (
                        <td className="px-3 text-right">
                          {line.weightedCogsPerUnit != null ? `$${line.weightedCogsPerUnit.toFixed(4)}` : "—"}
                        </td>
                      )}
                      <td className="px-3 text-right">{line.soldUnits}</td>
                      {isOwner && (
                        <td className="px-3 text-right">
                          {line.soldRevenue != null ? `$${line.soldRevenue.toFixed(2)}` : "—"}
                        </td>
                      )}
                      {isOwner && (
                        <td
                          className={cn(
                            "px-4 text-right",
                            line.profit != null && line.profit < 0 && "font-semibold text-danger"
                          )}
                        >
                          {line.profit != null ? `$${line.profit.toFixed(2)}` : "—"}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      </div>
    </AppShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-background p-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
