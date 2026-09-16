"use client";

import Link from "next/link";
import { useEffect, useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";

type Line = {
  id: string;
  upc: string | null;
  description: string;
  expectedQuantity: number;
  retailPrice: number;
  extendedRetail: number;
  category: string | null;
};

type SourcingLineEstimate = {
  id: string;
  upc: string | null;
  description: string;
  extendedRetail: number;
  estimatedUnitSalePrice: number | null;
  estimatedNetPerUnit: number | null;
  effectiveUnits: number;
  typicalPackSize: number;
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

type CandidateDetail = {
  id: string;
  title: string;
  supplier: string;
  purchased: boolean;
  createdAt: string;
  lines: Line[];
  sourcingEvaluation: SourcingEvaluation | null;
  summary: { totalManifestExtendedRetail: number };
};

// The Analyzer's detail view — deliberately much simpler than the real
// Manifests detail page (no receiving/reconciliation columns, since
// nothing's been scanned in yet; nothing has, because this is a candidate
// being evaluated before Cristian decides to buy it). "Mark as purchased"
// flips the same underlying Manifest record to purchased: true, at which
// point it's the exact same record shown on /manifests/[id] instead — no
// data copy, so its sourcing prediction stays attached for later
// predicted-vs-actual comparison.
export default function AnalyzerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null);
  const [startingEvaluation, setStartingEvaluation] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [showLineBreakdown, setShowLineBreakdown] = useState(false);
  const [markingPurchased, setMarkingPurchased] = useState(false);

  function load() {
    fetch(`/api/manifests/${id}`)
      .then((r) => r.json())
      .then(setCandidate);
  }

  useEffect(load, [id]);

  useEffect(() => {
    if (candidate?.sourcingEvaluation?.status !== "running") return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidate?.sourcingEvaluation?.status]);

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

  async function markPurchased() {
    if (
      !confirm(
        `Mark "${candidate?.title}" as purchased? It'll move to the Manifests list so you can start scanning it in.`
      )
    ) {
      return;
    }
    setMarkingPurchased(true);
    try {
      const res = await fetch(`/api/manifests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchased: true }),
      });
      if (!res.ok) throw new Error("Failed to mark as purchased.");
      router.push(`/manifests/${id}`);
    } catch (e) {
      setMarkingPurchased(false);
      alert(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  if (!candidate) return <main className="p-6">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{candidate.title}</h1>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm underline">
            Dashboard
          </Link>
          <Link href="/analyzer" className="text-sm underline">
            All candidates
          </Link>
          <Link href="/manifests" className="text-sm underline">
            Manifests
          </Link>
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-500">
        {new Date(candidate.createdAt).toLocaleDateString()} · {candidate.lines.length} line items · $
        {candidate.summary.totalManifestExtendedRetail.toFixed(2)} total retail value
      </p>

      <button
        type="button"
        onClick={markPurchased}
        disabled={markingPurchased}
        className="mb-6 rounded-lg bg-black px-4 py-3 text-center text-white disabled:opacity-40"
      >
        {markingPurchased ? "Marking…" : "Mark as purchased → move to Manifests"}
      </button>

      <section className="mb-6 flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Sourcing recommendation</label>
          {candidate.sourcingEvaluation?.status !== "running" && (
            <button
              type="button"
              onClick={runSourcingEvaluation}
              disabled={startingEvaluation}
              className="rounded border px-3 py-1.5 text-xs disabled:opacity-40"
            >
              {startingEvaluation
                ? "Starting…"
                : candidate.sourcingEvaluation
                  ? "Re-run evaluation"
                  : "Run sourcing evaluation"}
            </button>
          )}
        </div>
        {evaluationError && <p className="text-sm text-red-600">{evaluationError}</p>}

        {!candidate.sourcingEvaluation && !evaluationError && (
          <p className="text-xs text-gray-400">
            Checks real historical sold data, live eBay comps, and supplier patterns to suggest a max bid
            before you commit to buying this manifest.
          </p>
        )}

        {candidate.sourcingEvaluation?.status === "running" && (
          <p className="text-sm text-gray-500">
            Evaluating — checking historical sales, live comps, and market signal for each item. This can
            take a couple minutes for a large manifest…
          </p>
        )}

        {candidate.sourcingEvaluation?.status === "failed" && (
          <p className="text-sm text-red-600">
            Evaluation failed: {candidate.sourcingEvaluation.error ?? "unknown error"}
          </p>
        )}

        {candidate.sourcingEvaluation?.status === "complete" && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-3 py-1 text-sm font-semibold ${
                  candidate.sourcingEvaluation.recommendation === "buy"
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                {candidate.sourcingEvaluation.recommendation === "buy" ? "Buy" : "Don't buy"}
              </span>
              <span className="text-sm text-gray-600">
                Max recommended bid: <strong>${candidate.sourcingEvaluation.maxBid?.toFixed(2) ?? "—"}</strong>
              </span>
              {candidate.sourcingEvaluation.maxBid != null && candidate.sourcingEvaluation.expectedNetContribution != null && (
                <>
                  <span className="text-sm text-gray-600">
                    Est. profit at that bid:{" "}
                    <strong>
                      ${(candidate.sourcingEvaluation.expectedNetContribution - candidate.sourcingEvaluation.maxBid).toFixed(2)}
                    </strong>
                  </span>
                  <span className="text-sm text-gray-600">
                    Est. ROI:{" "}
                    <strong>
                      {candidate.sourcingEvaluation.maxBid > 0
                        ? (
                            ((candidate.sourcingEvaluation.expectedNetContribution - candidate.sourcingEvaluation.maxBid) /
                              candidate.sourcingEvaluation.maxBid) *
                            100
                          ).toFixed(0)
                        : "—"}
                      %
                    </strong>
                  </span>
                </>
              )}
              <span className="text-xs text-gray-400">
                {new Date(candidate.sourcingEvaluation.startedAt).toLocaleString()}
              </span>
            </div>
            {candidate.sourcingEvaluation.maxBid != null && (
              <p className="text-xs text-gray-400">
                Profit/ROI shown are what to expect if you win at exactly the max bid — bid lower and both
                improve, since the max bid is calibrated to hit your target margin (Settings) at that exact
                price.
              </p>
            )}
            {candidate.sourcingEvaluation.reasoning && (
              <p className="text-sm text-gray-700">{candidate.sourcingEvaluation.reasoning}</p>
            )}
            <button
              type="button"
              onClick={() => setShowLineBreakdown((v) => !v)}
              className="w-fit text-left text-xs text-gray-500 underline"
            >
              {showLineBreakdown ? "Hide" : "Show"} per-item breakdown (
              {candidate.sourcingEvaluation.lineEstimates.length} item
              {candidate.sourcingEvaluation.lineEstimates.length === 1 ? "" : "s"})
            </button>
            {showLineBreakdown && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left text-gray-500">
                      <th className="py-1 pr-2">Item</th>
                      <th className="px-2 text-right">Est. sale price (per unit)</th>
                      <th className="px-2 text-right">Sells as</th>
                      <th className="px-2 text-right">Est. net/unit</th>
                      <th className="px-2 text-right">Units</th>
                      <th className="px-2 text-left">Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidate.sourcingEvaluation.lineEstimates.map((e) => (
                      <tr key={e.id} className={`border-b ${e.flaggedDud ? "text-gray-400" : ""}`}>
                        <td className="py-1 pr-2">
                          {e.description} {e.flaggedDud && <span className="text-orange-500">(dud)</span>}
                        </td>
                        <td className="px-2 text-right">
                          {e.estimatedUnitSalePrice != null ? `$${e.estimatedUnitSalePrice.toFixed(2)}` : "—"}
                        </td>
                        <td className="px-2 text-right">
                          {e.typicalPackSize > 1 ? `${e.typicalPackSize}-pack` : "single"}
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

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="py-2 pr-2">Item</th>
              <th className="px-2 text-right">Expected qty</th>
              <th className="px-2 text-right">Retail price</th>
              <th className="px-2 text-right">Extended retail</th>
            </tr>
          </thead>
          <tbody>
            {candidate.lines.map((line) => (
              <tr key={line.id} className="border-b">
                <td className="py-2 pr-2">
                  <p className="font-medium">{line.description}</p>
                  <p className="text-xs text-gray-400">
                    {line.upc ?? "no UPC"}
                    {line.category ? ` · ${line.category}` : ""}
                  </p>
                </td>
                <td className="px-2 text-right">{line.expectedQuantity}</td>
                <td className="px-2 text-right">${line.retailPrice.toFixed(2)}</td>
                <td className="px-2 text-right">${line.extendedRetail.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
