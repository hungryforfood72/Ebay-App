"use client";

import { Stat } from "@/components/Stat";
import Link from "next/link";
import { useEffect, useState, use as usePromise } from "react";

type Line = {
  id: string;
  supplierSku: string | null;
  upc: string | null;
  description: string;
  expectedQuantity: number;
  retailPrice: number;
  extendedRetail: number;
  condition: string | null;
  category: string | null;
  subcategory: string | null;
  receivedUnits: number;
  damagedUnits: number;
  accountedUnits: number;
  missingUnits: number;
  weightedCogsPerUnit: number | null;
  soldUnits: number;
  soldRevenue: number;
  soldFees: number;
  profit: number | null;
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
  totalLandedCost: number | null;
  createdAt: string;
  lines: Line[];
  unmatchedReceived: { upc: string | null; units: number }[];
  unmatchedDamaged: { upc: string | null; units: number }[];
  unmatchedSold: { upc: string | null; units: number; revenue: number; fees: number }[];
  sourcingEvaluation: SourcingEvaluation | null;
  summary: {
    totalExpectedUnits: number;
    totalReceivedUnits: number;
    totalDamagedUnits: number;
    totalAccountedUnits: number;
    totalMissingUnits: number;
    totalManifestExtendedRetail: number;
    blendedCogsPerUnit: number | null;
    totalSoldUnits: number;
    totalSoldRevenue: number;
    totalSoldFees: number;
    totalProfit: number;
    totalListedUnsoldItems: number;
  };
};

export default function ManifestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [manifest, setManifest] = useState<ManifestDetail | null>(null);
  const [landedCostInput, setLandedCostInput] = useState("");
  const [savingCost, setSavingCost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discountMode, setDiscountMode] = useState<"percent" | "amount">("percent");
  const [discountValue, setDiscountValue] = useState("");
  const [applyingDiscount, setApplyingDiscount] = useState(false);
  const [discountResult, setDiscountResult] = useState<string | null>(null);
  const [startingEvaluation, setStartingEvaluation] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [showLineBreakdown, setShowLineBreakdown] = useState(false);

  function load() {
    fetch(`/api/manifests/${id}`)
      .then((r) => r.json())
      .then((data: ManifestDetail) => {
        setManifest(data);
        setLandedCostInput(data.totalLandedCost != null ? String(data.totalLandedCost) : "");
      });
  }

  useEffect(load, [id]);

  // Sourcing evaluation runs in the background (after()) — poll while one
  // is "running" so the card updates without a manual refresh, same
  // pattern src/app/review/page.tsx uses to catch AI-drafting background
  // work.
  useEffect(() => {
    if (manifest?.sourcingEvaluation?.status !== "running") return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest?.sourcingEvaluation?.status]);

  async function runSourcingEvaluation() {
    setStartingEvaluation(true);
    setEvaluationError(null);
    try {
      const res = await fetch(`/api/manifests/${id}/sourcing-evaluate`, { method: "POST" });
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        throw new Error(result.error ?? "Failed to start evaluation.");
      }
      load();
    } catch (e) {
      setEvaluationError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setStartingEvaluation(false);
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

  if (!manifest) return <main className="p-6">Loading…</main>;

  const s = manifest.summary;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{manifest.title}</h1>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm underline">
            Dashboard
          </Link>
          <Link href="/manifests" className="text-sm underline">
            All manifests
          </Link>
          <Link href="/review" className="text-sm underline">
            Review
          </Link>
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-500">
        {new Date(manifest.createdAt).toLocaleDateString()} · {manifest.lines.length} line items
      </p>

      <Link
        href={`/scan?manifestId=${manifest.id}`}
        className="mb-6 inline-block rounded-lg bg-black px-4 py-3 text-center text-white"
      >
        Scan into this manifest
      </Link>

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Expected units" value={s.totalExpectedUnits} />
        <Stat label="Received" value={s.totalReceivedUnits} />
        <Stat label="Damaged/expired" value={s.totalDamagedUnits} />
        <Stat
          label="Missing"
          value={s.totalMissingUnits}
          highlight={s.totalMissingUnits !== 0}
        />
        <Stat label="Sold units" value={s.totalSoldUnits} />
        <Stat label="Sold revenue" value={s.totalSoldRevenue} format="currency" />
        <Stat label="Sold fees" value={s.totalSoldFees} format="currency" />
        <Stat
          label="Profit"
          value={s.totalProfit}
          format="currency"
          highlight={s.totalSoldUnits > 0 && s.totalProfit < 0}
        />
      </section>

      <section className="mb-6 flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Sourcing recommendation</label>
          {manifest.sourcingEvaluation?.status !== "running" && (
            <button
              type="button"
              onClick={runSourcingEvaluation}
              disabled={startingEvaluation}
              className="rounded border px-3 py-1.5 text-xs disabled:opacity-40"
            >
              {startingEvaluation
                ? "Starting…"
                : manifest.sourcingEvaluation
                  ? "Re-run evaluation"
                  : "Run sourcing evaluation"}
            </button>
          )}
        </div>
        {evaluationError && <p className="text-sm text-red-600">{evaluationError}</p>}

        {!manifest.sourcingEvaluation && !evaluationError && (
          <p className="text-xs text-gray-400">
            Not evaluated yet — checks real historical sold data, live eBay comps, and supplier patterns
            to suggest a max bid before you commit to buying this manifest.
          </p>
        )}

        {manifest.sourcingEvaluation?.status === "running" && (
          <p className="text-sm text-gray-500">
            Evaluating — checking historical sales, live comps, and market signal for each item. This can
            take a couple minutes for a large manifest…
          </p>
        )}

        {manifest.sourcingEvaluation?.status === "failed" && (
          <p className="text-sm text-red-600">
            Evaluation failed: {manifest.sourcingEvaluation.error ?? "unknown error"}
          </p>
        )}

        {manifest.sourcingEvaluation?.status === "complete" && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-3 py-1 text-sm font-semibold ${
                  manifest.sourcingEvaluation.recommendation === "buy"
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                {manifest.sourcingEvaluation.recommendation === "buy" ? "Buy" : "Don't buy"}
              </span>
              <span className="text-sm text-gray-600">
                Max recommended bid: <strong>${manifest.sourcingEvaluation.maxBid?.toFixed(2) ?? "—"}</strong>
              </span>
              <span className="text-xs text-gray-400">
                {new Date(manifest.sourcingEvaluation.startedAt).toLocaleString()}
              </span>
            </div>
            {manifest.sourcingEvaluation.reasoning && (
              <p className="text-sm text-gray-700">{manifest.sourcingEvaluation.reasoning}</p>
            )}
            <button
              type="button"
              onClick={() => setShowLineBreakdown((v) => !v)}
              className="w-fit text-left text-xs text-gray-500 underline"
            >
              {showLineBreakdown ? "Hide" : "Show"} per-item breakdown (
              {manifest.sourcingEvaluation.lineEstimates.length} item{manifest.sourcingEvaluation.lineEstimates.length === 1 ? "" : "s"})
            </button>
            {showLineBreakdown && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="py-1 pr-2">Item</th>
                      <th className="px-2 text-right">Est. sale price</th>
                      <th className="px-2 text-right">Est. net/unit</th>
                      <th className="px-2 text-right">Units</th>
                      <th className="px-2 text-left">Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifest.sourcingEvaluation.lineEstimates.map((e) => (
                      <tr key={e.id} className={`border-b ${e.flaggedDud ? "text-gray-400" : ""}`}>
                        <td className="py-1 pr-2">
                          {e.description} {e.flaggedDud && <span className="text-orange-500">(dud)</span>}
                        </td>
                        <td className="px-2 text-right">
                          {e.estimatedUnitSalePrice != null ? `$${e.estimatedUnitSalePrice.toFixed(2)}` : "—"}
                        </td>
                        <td className="px-2 text-right">
                          {e.estimatedNetPerUnit != null ? `$${e.estimatedNetPerUnit.toFixed(2)}` : "—"}
                        </td>
                        <td className="px-2 text-right">{e.effectiveUnits}</td>
                        <td className="px-2 text-left">{e.dataConfidence.replace("_", " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="mb-6 flex flex-col gap-2 rounded-lg border p-4">
        <label className="text-sm font-medium">Total landed cost for this load</label>
        <div className="flex gap-2">
          <input
            type="number"
            step="0.01"
            value={landedCostInput}
            onChange={(e) => setLandedCostInput(e.target.value)}
            placeholder="e.g. 1200.00"
            className="flex-1 rounded border px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={saveLandedCost}
            disabled={savingCost}
            className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
          >
            Save
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {s.blendedCogsPerUnit != null ? (
          <p className="text-sm text-gray-600">
            Blended COGS: <strong>${s.blendedCogsPerUnit.toFixed(4)}</strong> per unit (landed cost ÷{" "}
            {s.totalReceivedUnits} units received). Per-line weighted cost below accounts for each
            item&apos;s share of the load&apos;s declared value, divided by that line&apos;s good units
            received — damaged/expired and still-missing units aren&apos;t counted.
          </p>
        ) : (
          <p className="text-xs text-gray-400">Enter a landed cost to see COGS per unit.</p>
        )}
      </section>

      <section className="mb-6 flex flex-col gap-2 rounded-lg border p-4">
        <label className="text-sm font-medium">Bulk discount remaining unsold listings</label>
        <p className="text-xs text-gray-400">
          {s.totalListedUnsoldItems} item(s) still listed, unsold. Discount is applied relative to each
          item&apos;s own current price, not one shared price.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={discountMode}
            onChange={(e) => setDiscountMode(e.target.value as "percent" | "amount")}
            className="rounded border px-2 py-2 text-sm"
          >
            <option value="percent">% off</option>
            <option value="amount">$ off</option>
          </select>
          <input
            type="number"
            step="0.01"
            min={0}
            value={discountValue}
            onChange={(e) => setDiscountValue(e.target.value)}
            placeholder={discountMode === "percent" ? "e.g. 15" : "e.g. 5.00"}
            className="w-28 rounded border px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={applyDiscount}
            disabled={applyingDiscount || !discountValue || s.totalListedUnsoldItems === 0}
            className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
          >
            {applyingDiscount ? "Applying…" : "Apply"}
          </button>
        </div>
        {discountResult && <p className="text-sm text-gray-600">{discountResult}</p>}
      </section>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="py-2 pr-2">Item</th>
              <th className="px-2 text-right">Expected</th>
              <th className="px-2 text-right">Received</th>
              <th className="px-2 text-right">Damaged</th>
              <th className="px-2 text-right">Missing</th>
              <th className="px-2 text-right">Weighted COGS/unit</th>
              <th className="px-2 text-right">Sold</th>
              <th className="px-2 text-right">Sold Revenue</th>
              <th className="px-2 text-right">Profit</th>
            </tr>
          </thead>
          <tbody>
            {manifest.lines.map((line) => (
              <tr key={line.id} className="border-b">
                <td className="py-2 pr-2">
                  <p className="font-medium">{line.description}</p>
                  <p className="text-xs text-gray-400">
                    {line.upc ?? "no UPC"} · ${line.retailPrice.toFixed(2)} retail
                  </p>
                </td>
                <td className="px-2 text-right">{line.expectedQuantity}</td>
                <td className="px-2 text-right">{line.receivedUnits}</td>
                <td className="px-2 text-right">{line.damagedUnits}</td>
                <td className={`px-2 text-right ${line.missingUnits !== 0 ? "font-semibold text-red-600" : ""}`}>
                  {line.missingUnits}
                </td>
                <td className="px-2 text-right">
                  {line.weightedCogsPerUnit != null ? `$${line.weightedCogsPerUnit.toFixed(4)}` : "—"}
                </td>
                <td className="px-2 text-right">{line.soldUnits}</td>
                <td className="px-2 text-right">${line.soldRevenue.toFixed(2)}</td>
                <td
                  className={`px-2 text-right ${line.profit != null && line.profit < 0 ? "font-semibold text-red-600" : ""}`}
                >
                  {line.profit != null ? `$${line.profit.toFixed(2)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(manifest.unmatchedReceived.length > 0 ||
        manifest.unmatchedDamaged.length > 0 ||
        manifest.unmatchedSold.length > 0) && (
        <section className="mt-6 rounded-lg border border-orange-300 bg-orange-50 p-4 text-sm">
          <p className="mb-2 font-medium">Scanned items not on this manifest</p>
          {manifest.unmatchedReceived.map((u) => (
            <p key={`r-${u.upc}`}>Received {u.units} unit(s) of UPC {u.upc ?? "(none)"} — not on the manifest.</p>
          ))}
          {manifest.unmatchedDamaged.map((u) => (
            <p key={`d-${u.upc}`}>Marked {u.units} unit(s) damaged for UPC {u.upc} — not on the manifest.</p>
          ))}
          {manifest.unmatchedSold.map((u) => (
            <p key={`s-${u.upc}`}>
              Sold {u.units} unit(s) of UPC {u.upc ?? "(none)"} (${u.revenue.toFixed(2)} revenue) — not on the
              manifest.
            </p>
          ))}
        </section>
      )}
    </main>
  );
}
