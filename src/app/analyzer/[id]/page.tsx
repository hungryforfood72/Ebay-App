"use client";

import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/Input";
import { ChevronDown, CircleCheck, Pencil, RefreshCw, Upload } from "lucide-react";
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
  recommendedPackSize: number | null;
  recommendedPackBasis: "listings" | "estimate" | null;
  dataConfidence: string;
  flaggedDud: boolean;
  slowMover: boolean;
  monthsToSellThrough: number | null;
};

type SourcingEvaluation = {
  id: string;
  status: "running" | "complete" | "failed";
  recommendation: "buy" | "dont_buy" | null;
  maxBid: number | null;
  expectedNetContribution: number | null;
  targetMarginPct: number | null;
  minBidFloor: number | null;
  dudShare: number | null;
  concentrationRisk: boolean | null;
  reasoning: string | null;
  error: string | null;
  processedSteps: number;
  totalSteps: number;
  startedAt: string;
  completedAt: string | null;
  lineEstimates: SourcingLineEstimate[];
};

type CandidateDetail = {
  id: string;
  title: string;
  supplier: string;
  purchased: boolean;
  bidStatus: BidStatus;
  bidAmount: number | null;
  bidPlacedAt: string | null;
  bidClosedAt: string | null;
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
  const [customBid, setCustomBid] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [savingBid, setSavingBid] = useState(false);
  const [bidError, setBidError] = useState<string | null>(null);

  function load() {
    fetch(`/api/manifests/${id}`)
      .then((r) => r.json())
      .then((data: CandidateDetail) => {
        setCandidate(data);
        setTitleInput(data.title);
        // Seed the "try a price" calculator with the max bid whenever a
        // freshly-completed evaluation comes back — harmless to also run
        // while a re-run is still "running" (maxBid is null then, so this
        // just no-ops), and never overwrites a price Cristian's actively
        // typing into it once polling has stopped.
        if (data.sourcingEvaluation?.status === "complete" && data.sourcingEvaluation.maxBid != null) {
          setCustomBid(data.sourcingEvaluation.maxBid.toFixed(2));
        }
      });
  }

  useEffect(load, [id]);

  useEffect(() => {
    if (candidate?.sourcingEvaluation?.status !== "running") return;
    // 2s while running so the progress bar actually reads as live; the
    // evaluation itself already throttles its own DB writes to ~700ms, so
    // polling faster than that wouldn't show anything new anyway.
    const interval = setInterval(load, 2000);
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

  async function saveTitle() {
    const trimmed = titleInput.trim();
    if (!trimmed) return;
    setSavingTitle(true);
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
      alert(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSavingTitle(false);
    }
  }

  async function saveBid(bidStatus: "active" | "lost" | null, bidAmount?: number) {
    setSavingBid(true);
    setBidError(null);
    try {
      const res = await fetch(`/api/manifests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bidStatus, bidAmount }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error ?? "Couldn't save the bid.");
      load();
    } catch (e) {
      setBidError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSavingBid(false);
    }
  }

  async function markPurchased() {
    const wonBid = candidate?.bidStatus === "active" && candidate.bidAmount != null;
    if (
      !confirm(
        wonBid
          ? `Won "${candidate?.title}" at $${candidate?.bidAmount?.toFixed(2)}? It'll move to the Manifests list so you can start scanning it in.`
          : `Mark "${candidate?.title}" as purchased? It'll move to the Manifests list so you can start scanning it in.`
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

  if (!candidate) {
    return (
      <AppShell title="Analyzer">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    );
  }

  const evaluation = candidate.sourcingEvaluation;

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
                    setTitleInput(candidate.title);
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
                setTitleInput(candidate.title);
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-x-2">
            {candidate.title}
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              aria-label="Rename"
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
          <Link href="/analyzer" className="font-medium text-primary hover:underline">
            All candidates
          </Link>
          <span aria-hidden>·</span>
          {new Date(candidate.createdAt).toLocaleDateString()}
          <span aria-hidden>·</span>
          {candidate.lines.length} line items
          <span aria-hidden>·</span>${candidate.summary.totalManifestExtendedRetail.toFixed(2)} retail
        </span>
      }
      actions={
        <>
          {/* With an active bid, the Bid card's "Won, mark as purchased" does this. */}
          {candidate.bidStatus !== "active" && (
            <Button onClick={markPurchased} disabled={markingPurchased}>
              <CircleCheck className="size-4" aria-hidden />
              {markingPurchased ? "Marking…" : "Mark as purchased"}
            </Button>
          )}
          <Link href="/analyzer" className={buttonClasses({ variant: "outline" })}>
            <Upload className="size-4" aria-hidden />
            Upload another
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <BidCard
          bidStatus={candidate.bidStatus}
          bidAmount={candidate.bidAmount}
          bidPlacedAt={candidate.bidPlacedAt}
          bidClosedAt={candidate.bidClosedAt}
          maxBid={evaluation?.status === "complete" ? evaluation.maxBid : null}
          saving={savingBid}
          error={bidError}
          onSave={saveBid}
          onWon={markPurchased}
        />

        <Card>
          <SectionHeader
            title="Sourcing recommendation"
            action={
              evaluation?.status !== "running" ? (
                <Button variant="outline" size="sm" onClick={runSourcingEvaluation} disabled={startingEvaluation}>
                  <RefreshCw className={cn("size-4", startingEvaluation && "animate-spin")} aria-hidden />
                  {startingEvaluation ? "Starting…" : evaluation ? "Re-run" : "Run evaluation"}
                </Button>
              ) : undefined
            }
          />
          {evaluationError && <p className="mb-3 text-sm font-medium text-danger">{evaluationError}</p>}

          {!evaluation && !evaluationError && (
            <p className="text-sm text-muted-foreground">
              Checks real historical sold data, live eBay comps, and supplier patterns to suggest a max bid before
              you commit to buying this manifest.
            </p>
          )}

          {evaluation?.status === "running" && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                Evaluating — checking historical sales, live comps, and market signal for each item. This can take a
                couple minutes for a large manifest…
              </p>
              {(() => {
                const { processedSteps, totalSteps } = evaluation;
                const pct = totalSteps > 0 ? Math.min(100, Math.round((processedSteps / totalSteps) * 100)) : 0;
                return (
                  <>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-xs font-medium text-muted-foreground tabular-nums">
                      {totalSteps > 0 ? `${pct}% · ${processedSteps} of ${totalSteps} items checked` : "Starting…"}
                    </p>
                  </>
                );
              })()}
            </div>
          )}

          {evaluation?.status === "failed" && (
            <Alert tone="danger" title="Evaluation failed">
              {evaluation.error ?? "unknown error"}
            </Alert>
          )}

          {evaluation?.status === "complete" && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={evaluation.recommendation === "buy" ? "success" : "danger"} size="lg">
                  {evaluation.recommendation === "buy" ? "Buy" : "Don't buy"}
                </Badge>
                <span className="text-xs text-muted-foreground">{new Date(evaluation.startedAt).toLocaleString()}</span>
              </div>

              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Metric
                  label="Max recommended bid"
                  value={evaluation.maxBid != null ? `$${evaluation.maxBid.toFixed(2)}` : "—"}
                  emphasis
                />
                {evaluation.maxBid != null && evaluation.expectedNetContribution != null && (
                  <>
                    <Metric
                      label="Est. profit at that bid"
                      value={`$${(evaluation.expectedNetContribution - evaluation.maxBid).toFixed(2)}`}
                    />
                    <Metric
                      label="Est. ROI"
                      value={
                        evaluation.maxBid > 0
                          ? `${(
                              ((evaluation.expectedNetContribution - evaluation.maxBid) / evaluation.maxBid) *
                              100
                            ).toFixed(0)}%`
                          : "—"
                      }
                    />
                  </>
                )}
              </dl>
              {evaluation.maxBid != null && (
                <p className="text-xs text-muted-foreground">
                  Profit/ROI shown are what to expect if you win at exactly the max bid — bid lower and both improve,
                  since the max bid is calibrated to hit your target margin (Settings) at that exact price.
                </p>
              )}

              {evaluation.expectedNetContribution != null && (
                <div className="rounded-xl border border-border bg-background p-4">
                  <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
                    <div className="w-40">
                      <label htmlFor="try-bid" className="mb-1.5 block text-sm font-medium text-foreground">
                        What if I bid…
                      </label>
                      <div className="relative">
                        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">
                          $
                        </span>
                        <Input
                          id="try-bid"
                          type="number"
                          step="0.01"
                          min="0"
                          value={customBid}
                          onChange={(e) => setCustomBid(e.target.value)}
                          placeholder="0.00"
                          className="pl-7"
                        />
                      </div>
                    </div>
                    {(() => {
                      const bid = parseFloat(customBid);
                      const contribution = evaluation.expectedNetContribution!;
                      if (!Number.isFinite(bid) || bid <= 0) return null;
                      const profit = contribution - bid;
                      const roi = (profit / bid) * 100;
                      const targetMarginPct = evaluation.targetMarginPct;
                      // Compare against the ROUNDED figure, same as what's shown
                      // (roi.toFixed(0) below) — maxBid/expectedNetContribution
                      // are themselves rounded-to-cents Decimals, so recomputing
                      // ROI from them lands a hair off the exact target (e.g.
                      // 34.97% instead of 35.00%). Comparing the raw float
                      // against the integer target made bidding exactly at the
                      // recommended max bid show "35%" right next to "Below
                      // your 35% target" — a real contradiction, not just a
                      // display quirk, since the max bid is defined as the
                      // price that exactly clears the target.
                      const clearsTarget = targetMarginPct != null ? Math.round(roi) >= targetMarginPct : null;
                      return (
                        <>
                          <div>
                            <p className="text-xs font-medium text-muted-foreground">Profit</p>
                            <p
                              className={cn(
                                "text-lg font-semibold tabular-nums",
                                profit >= 0 ? "text-success" : "text-danger"
                              )}
                            >
                              ${profit.toFixed(2)}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs font-medium text-muted-foreground">ROI</p>
                            <p
                              className={cn(
                                "text-lg font-semibold tabular-nums",
                                profit >= 0 ? "text-success" : "text-danger"
                              )}
                            >
                              {roi.toFixed(0)}%
                            </p>
                          </div>
                          {clearsTarget != null && (
                            <Badge tone={clearsTarget ? "success" : "warning"} className="mb-1">
                              {clearsTarget ? `Clears your ${targetMarginPct}% target` : `Below your ${targetMarginPct}% target`}
                            </Badge>
                          )}
                          {evaluation.maxBid != null && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setCustomBid(evaluation.maxBid!.toFixed(2))}
                              className="mb-0.5"
                            >
                              Reset to max bid
                            </Button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                  {(() => {
                    const bid = parseFloat(customBid);
                    if (!Number.isFinite(bid) || bid <= 0) return null;
                    const { dudShare, concentrationRisk, targetMarginPct, minBidFloor, expectedNetContribution } =
                      evaluation;
                    if (expectedNetContribution == null) return null;

                    // The original recommendation can land on "dont_buy" for
                    // reasons that have nothing to do with the price paid —
                    // too many duds, or one weak item dominating the manifest
                    // (see evaluateManifest's recommendation logic). No bid,
                    // however low, fixes those, so a hypothetical price never
                    // gets to override them — Cristian's own instruction:
                    // only let the price change the verdict when the original
                    // "no" actually was about price.
                    const structuralReasons: string[] = [];
                    if (dudShare != null && dudShare >= 0.6) {
                      structuralReasons.push(`${(dudShare * 100).toFixed(0)}% of lines are likely duds`);
                    }
                    if (concentrationRisk) {
                      structuralReasons.push("one item dominates the manifest's value and looks weak");
                    }

                    let good: boolean;
                    let label: string;
                    if (structuralReasons.length > 0) {
                      good = false;
                      label = "Still don't buy";
                    } else {
                      const roi = ((expectedNetContribution - bid) / bid) * 100;
                      const clearsFloor = minBidFloor == null || bid >= minBidFloor;
                      // Same rounding-consistency fix as the ROI badge above —
                      // compare the displayed whole-percent figure, not the
                      // raw float, so this can't disagree with the number
                      // shown right next to it.
                      const clearsMargin = targetMarginPct == null || Math.round(roi) >= targetMarginPct;
                      good = clearsFloor && clearsMargin;
                      label = good ? "Buy at this price" : "Don't buy at this price";
                    }

                    return (
                      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                        <Badge tone={good ? "success" : "danger"} size="lg">
                          {label}
                        </Badge>
                        {structuralReasons.length > 0 && (
                          <span className="text-sm text-muted-foreground">
                            Not a price issue — {structuralReasons.join(" and ")}. No bid price fixes this.
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {evaluation.reasoning && (
                <p className="text-sm leading-relaxed text-foreground">{evaluation.reasoning}</p>
              )}

              <div>
                <Button variant="ghost" size="sm" onClick={() => setShowLineBreakdown((v) => !v)} className="-ml-2">
                  <ChevronDown className={cn("size-4 transition-transform", showLineBreakdown && "rotate-180")} aria-hidden />
                  {showLineBreakdown ? "Hide" : "Show"} per-item breakdown ({evaluation.lineEstimates.length} item
                  {evaluation.lineEstimates.length === 1 ? "" : "s"})
                </Button>
              </div>

              {showLineBreakdown && (
                <>
                  <ul className="flex flex-col gap-2 md:hidden">
                    {evaluation.lineEstimates.map((e) => (
                      <li
                        key={e.id}
                        className={cn("rounded-xl border border-border bg-background p-3", e.flaggedDud && "opacity-60")}
                      >
                        <p className="text-sm font-medium leading-snug text-foreground">{e.description}</p>
                        <EstimateTags estimate={e} />
                        <dl className="mt-2 grid grid-cols-4 gap-2 text-xs tabular-nums">
                          <MiniStat
                            label="Sale/unit"
                            value={e.estimatedUnitSalePrice != null ? `$${e.estimatedUnitSalePrice.toFixed(2)}` : "—"}
                          />
                          <MiniStat
                            label="Net/unit"
                            value={e.estimatedNetPerUnit != null ? `$${e.estimatedNetPerUnit.toFixed(2)}` : "—"}
                          />
                          <MiniStat label="Units" value={String(e.effectiveUnits)} />
                          <MiniStat label="Sell as" value={sellAs(e)} />
                        </dl>
                      </li>
                    ))}
                  </ul>
                  <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
                    <table className="w-full text-sm">
                      <thead className="bg-background">
                        <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                          <th className="px-4 py-3">Item</th>
                          <th className="px-3 py-3 text-right">Est. sale/unit</th>
                          <th className="px-3 py-3 text-right">Sell as</th>
                          <th className="px-3 py-3 text-right">Est. net/unit</th>
                          <th className="px-3 py-3 text-right">Units</th>
                          <th className="px-4 py-3">Confidence</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border tabular-nums">
                        {evaluation.lineEstimates.map((e) => (
                          <tr key={e.id} className={cn("hover:bg-background", e.flaggedDud && "text-muted-foreground")}>
                            <td className="px-4 py-2.5">
                              <p className={cn("font-medium", !e.flaggedDud && "text-foreground")}>{e.description}</p>
                              <EstimateTags estimate={e} showConfidence={false} />
                            </td>
                            <td className="px-3 text-right">
                              {e.estimatedUnitSalePrice != null ? `$${e.estimatedUnitSalePrice.toFixed(2)}` : "—"}
                            </td>
                            <td className="px-3 text-right">{sellAs(e)}</td>
                            <td className="px-3 text-right">
                              {e.estimatedNetPerUnit != null ? `$${e.estimatedNetPerUnit.toFixed(2)}` : "—"}
                            </td>
                            <td className="px-3 text-right">{e.effectiveUnits}</td>
                            <td className="px-4">
                              <ConfidenceBadge confidence={e.dataConfidence} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>

        <section>
          <SectionHeader title="Manifest lines" action={<Badge>{candidate.lines.length}</Badge>} />
          <ul className="flex flex-col gap-2 md:hidden">
            {candidate.lines.map((line) => (
              <li key={line.id} className="rounded-xl border border-border bg-surface p-3 shadow-sm">
                <p className="font-medium leading-snug text-foreground">{line.description}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {line.upc ?? "no UPC"}
                  {line.category ? ` · ${line.category}` : ""}
                </p>
                <p className="mt-2 flex flex-wrap gap-x-3 text-sm tabular-nums text-muted-foreground">
                  <span>
                    Qty <span className="font-medium text-foreground">{line.expectedQuantity}</span>
                  </span>
                  <span>
                    Retail <span className="font-medium text-foreground">${line.retailPrice.toFixed(2)}</span>
                  </span>
                  <span>
                    Ext. <span className="font-medium text-foreground">${line.extendedRetail.toFixed(2)}</span>
                  </span>
                </p>
              </li>
            ))}
          </ul>
          <Card padded={false} className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-background">
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th className="px-4 py-3">Item</th>
                    <th className="px-3 py-3 text-right">Expected qty</th>
                    <th className="px-3 py-3 text-right">Retail price</th>
                    <th className="px-4 py-3 text-right">Extended retail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border tabular-nums">
                  {candidate.lines.map((line) => (
                    <tr key={line.id} className="hover:bg-background">
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-foreground">{line.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {line.upc ?? "no UPC"}
                          {line.category ? ` · ${line.category}` : ""}
                        </p>
                      </td>
                      <td className="px-3 text-right">{line.expectedQuantity}</td>
                      <td className="px-3 text-right">${line.retailPrice.toFixed(2)}</td>
                      <td className="px-4 text-right">${line.extendedRetail.toFixed(2)}</td>
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

type BidStatus = "active" | "lost" | "won" | null;

// Where this candidate stands at auction: no bid yet, an active bid (with
// how it compares to the recommended max), or lost. Winning is "Mark as
// purchased" — the API records the bid as won when that happens.
function BidCard({
  bidStatus,
  bidAmount,
  bidPlacedAt,
  bidClosedAt,
  maxBid,
  saving,
  error,
  onSave,
  onWon,
}: {
  bidStatus: BidStatus;
  bidAmount: number | null;
  bidPlacedAt: string | null;
  bidClosedAt: string | null;
  maxBid: number | null;
  saving: boolean;
  error: string | null;
  onSave: (status: "active" | "lost" | null, amount?: number) => void;
  onWon: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [amountInput, setAmountInput] = useState("");
  const showForm = bidStatus === null || editing;
  const amount = Number(amountInput);
  const validAmount = amountInput.trim() !== "" && Number.isFinite(amount) && amount > 0;

  function startEditing(prefill: number | null) {
    setAmountInput(prefill != null ? prefill.toFixed(2) : "");
    setEditing(true);
  }

  function submit() {
    if (!validAmount) return;
    onSave("active", amount);
    setEditing(false);
  }

  return (
    <Card>
      <SectionHeader
        title="Your bid"
        action={
          bidStatus === "active" ? (
            <Badge tone="primary">Active bid</Badge>
          ) : bidStatus === "lost" ? (
            <Badge tone="neutral">Lost</Badge>
          ) : undefined
        }
      />

      {bidStatus === "active" && !editing && bidAmount != null && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-2xl font-semibold tabular-nums text-foreground">{money(bidAmount)}</p>
            {bidPlacedAt && (
              <p className="text-sm text-muted-foreground">placed {new Date(bidPlacedAt).toLocaleDateString()}</p>
            )}
          </div>
          <BidVsMax bid={bidAmount} maxBid={maxBid} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={onWon} disabled={saving}>
              <CircleCheck className="size-4" aria-hidden />
              Won, mark as purchased
            </Button>
            <Button variant="outline" onClick={() => startEditing(bidAmount)} disabled={saving}>
              Change amount
            </Button>
            <Button variant="danger-ghost" onClick={() => onSave("lost")} disabled={saving}>
              Bid lost
            </Button>
          </div>
        </div>
      )}

      {bidStatus === "lost" && !editing && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Lost{bidAmount != null && <> at {money(bidAmount)}</>}
            {bidClosedAt && <> · {new Date(bidClosedAt).toLocaleDateString()}</>}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => startEditing(bidAmount)} disabled={saving}>
              Bid again
            </Button>
            <Button variant="ghost" onClick={() => onSave(null)} disabled={saving}>
              Move back to under consideration
            </Button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="flex flex-col gap-2">
          {bidStatus === null && (
            <p className="text-sm text-muted-foreground">
              Placed a bid on this load? Record it here to keep track of it until you win or lose.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40">
              <label htmlFor="bid-amount" className="mb-1.5 block text-sm font-medium text-foreground">
                Bid amount
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">
                  $
                </span>
                <Input
                  id="bid-amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder={maxBid != null ? maxBid.toFixed(2) : "0.00"}
                  className="pl-7"
                />
              </div>
            </div>
            <Button onClick={submit} disabled={saving || !validAmount}>
              {saving ? "Saving…" : bidStatus === "active" ? "Update bid" : "Mark as active bid"}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
            )}
          </div>
          {validAmount ? (
            <BidVsMax bid={amount} maxBid={maxBid} />
          ) : (
            maxBid != null && <p className="text-xs text-muted-foreground">Recommended max bid: {money(maxBid)}</p>
          )}
        </div>
      )}

      {error && <p className="mt-3 text-sm font-medium text-danger">{error}</p>}
    </Card>
  );
}

function BidVsMax({ bid, maxBid }: { bid: number; maxBid: number | null }) {
  if (maxBid == null) {
    return <p className="text-xs text-muted-foreground">No recommended max bid yet. Run the evaluation to compare.</p>;
  }
  const diff = maxBid - bid;
  if (Math.abs(diff) < 0.005) {
    return <p className="text-sm font-medium text-foreground">Right at the recommended max bid.</p>;
  }
  return diff > 0 ? (
    <p className="text-sm font-medium text-success">
      {money(diff)} under the recommended max of {money(maxBid)}
    </p>
  ) : (
    <p className="text-sm font-medium text-warning">
      {money(-diff)} over the recommended max of {money(maxBid)}, so below your target margin if you win
    </p>
  );
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The recommended pack size when there is one (see src/lib/packSize.ts),
// otherwise how it's most commonly listed. "~" marks one modeled from
// singles rather than priced off real multi-pack listings.
function sellAs(e: SourcingLineEstimate): string {
  const size = e.recommendedPackSize ?? e.typicalPackSize;
  const label = size > 1 ? `${size}-pack` : "single";
  return e.recommendedPackBasis === "estimate" ? `~${label}` : label;
}

function Metric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={cn("rounded-lg p-3", emphasis ? "bg-blue-50" : "bg-background")}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 text-lg font-semibold tabular-nums", emphasis ? "text-primary" : "text-foreground")}>
        {value}
      </dd>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium text-foreground">{value}</dd>
    </div>
  );
}

const CONFIDENCE_TONES: Record<string, BadgeTone> = {
  own_history: "success",
  historical_match: "success",
  web_price_check: "primary",
  category_fallback: "warning",
  market_only: "neutral",
};

function ConfidenceBadge({ confidence }: { confidence: string }) {
  // replaceAll, not replace — "web_price_check" has two underscores, and the
  // old single replace() rendered it as "web price_check".
  return <Badge tone={CONFIDENCE_TONES[confidence] ?? "neutral"}>{confidence.replaceAll("_", " ")}</Badge>;
}

// Dud / slow-mover flags (and, on phones where there's no confidence
// column, the confidence badge) under an estimate's description.
function EstimateTags({ estimate: e, showConfidence = true }: { estimate: SourcingLineEstimate; showConfidence?: boolean }) {
  if (!e.flaggedDud && !e.slowMover && !showConfidence) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {showConfidence && <ConfidenceBadge confidence={e.dataConfidence} />}
      {e.flaggedDud && <Badge tone="warning">dud</Badge>}
      {e.slowMover && (
        <Badge tone="purple">
          slow mover
          {e.monthsToSellThrough != null && e.monthsToSellThrough < 60
            ? ` · ~${e.monthsToSellThrough.toFixed(1)}mo to sell through`
            : ""}
        </Badge>
      )}
    </div>
  );
}
