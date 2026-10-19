"use client";

import { ConsignmentPickListView, ConsignmentTermsCard, type ConsignmentPickListData } from "@/components/ConsignmentPickList";
import { SupplierShareCard } from "@/components/SupplierShareCard";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { ebayBanReason } from "@/lib/ebayBanned";
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
  recommendedPackBasis: "agent" | "listings" | "estimate" | null;
  dataConfidence: string;
  flaggedDud: boolean;
  slowMover: boolean;
  monthsToSellThrough: number | null;
  sellRateSource: "own" | "ebay_listings" | "web_demand" | "quick_demand" | "category" | null;
  longTail: boolean;
};

type SourcingEvaluation = {
  id: string;
  // "compliant" = the current Analyzer, "legacy" = the original comps-based one.
  engine: "compliant" | "legacy";
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
  consignment: boolean;
  consignmentSupplierPct: number;
  shareToken: string | null;
  consignmentPickList: ConsignmentPickListData | null;
  // Analyzer Beta copy (see src/app/analyzer/beta): priced without other
  // sellers' eBay data, compared against the original's standard call.
  analyzerBeta: boolean;
  betaComparison?: BetaComparison;
  // The other Analyzer's latest finished run on this manifest, if it's been
  // run both ways.
  engineComparison?: CompareEvaluation | null;
};

type BetaComparison = {
  source: { id: string; title: string } | null;
  evaluation: CompareEvaluation | null;
};

type CompareEvaluation = {
    recommendation: "buy" | "dont_buy" | null;
    maxBid: number | null;
    expectedNetContribution: number | null;
    dudShare: number | null;
    startedAt: string;
    lineEstimates: {
      upc: string | null;
      description: string;
      estimatedUnitSalePrice: number | null;
      estimatedNetPerUnit: number | null;
      effectiveUnits: number;
      dataConfidence: string;
      flaggedDud: boolean;
    }[];
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

  // engine "legacy" runs the original comps-based Analyzer, after a warning:
  // it uses other sellers' eBay data, which eBay's API terms don't allow
  // for pricing (2026-10-18 switch, see SourcingEvaluation.engine).
  async function runSourcingEvaluation(engine?: "legacy") {
    if (
      engine === "legacy" &&
      !confirm(
        "Run the legacy Analyzer? It prices from other sellers' eBay listings and sold counts, which eBay's API terms don't allow. The current Analyzer doesn't."
      )
    ) {
      return;
    }
    setStartingEvaluation(true);
    setEvaluationError(null);
    try {
      const res = await fetch(`/api/manifests/${id}/sourcing-evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(engine ? { engine } : {}),
      });
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

  async function deleteBetaCopy() {
    if (!confirm(`Delete the comparison copy "${candidate?.title}"? The original manifest isn't affected.`)) return;
    const res = await fetch(`/api/manifests/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      alert(result.error ?? "Couldn't delete the copy.");
      return;
    }
    router.push("/analyzer/beta");
  }

  if (!candidate) {
    return (
      <AppShell title="Analyzer">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    );
  }

  const evaluation = candidate.sourcingEvaluation;
  const beta = candidate.analyzerBeta;
  // Other-supplier manifests are priced by the box (see
  // estimateOtherSupplierLine), so their counts are boxes, not pieces.
  const unitsLabel = candidate.supplier === "unknown" ? "Boxes" : "Units";

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
          {beta ? (
            <Link href="/analyzer/beta" className="font-medium text-primary hover:underline">
              Compare Analyzers
            </Link>
          ) : (
            <Link href="/analyzer" className="font-medium text-primary hover:underline">
              All candidates
            </Link>
          )}
          <span aria-hidden>·</span>
          {new Date(candidate.createdAt).toLocaleDateString()}
          <span aria-hidden>·</span>
          {candidate.lines.length} line items
          <span aria-hidden>·</span>${candidate.summary.totalManifestExtendedRetail.toFixed(2)} retail
        </span>
      }
      actions={
        beta ? (
          <Button variant="danger-ghost" onClick={deleteBetaCopy}>
            Delete copy
          </Button>
        ) : (
        <>
          {/* With an active bid, the Bid card's "Won, mark as purchased" does this. */}
          {candidate.bidStatus !== "active" && (
            <Button onClick={markPurchased} disabled={markingPurchased}>
              <CircleCheck className="size-4" aria-hidden />
              {markingPurchased ? "Marking…" : candidate.consignment ? "Mark as taken" : "Mark as purchased"}
            </Button>
          )}
          <Link href="/analyzer" className={buttonClasses({ variant: "outline" })}>
            <Upload className="size-4" aria-hidden />
            Upload another
          </Link>
        </>
        )
      }
    >
      <div className="flex flex-col gap-6">
        {beta && (
          <Alert tone="info" title="Comparison copy">
            A copy for comparing the current Analyzer with the legacy one on the same load. It can&apos;t be bought or
            bid on.
            {candidate.betaComparison?.source && (
              <>
                {" "}
                Copied from{" "}
                <Link href={`/manifests/${candidate.betaComparison.source.id}`} className="font-medium text-primary hover:underline">
                  {candidate.betaComparison.source.title}
                </Link>
                .
              </>
            )}
          </Alert>
        )}

        {!beta && (
          <ConsignmentTermsCard
            manifestId={candidate.id}
            consignment={candidate.consignment}
            supplierPct={candidate.consignmentSupplierPct}
            onSaved={load}
          />
        )}
        {candidate.consignment && (
          <SupplierShareCard manifestId={candidate.id} shareToken={candidate.shareToken} onChange={load} />
        )}

        {!candidate.consignment && !beta && (
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
        )}

        <Card>
          <SectionHeader
            title="Sourcing recommendation"
            action={
              evaluation?.status !== "running" ? (
                <div className="flex flex-wrap items-center gap-1">
                  {!beta && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => runSourcingEvaluation("legacy")}
                      disabled={startingEvaluation}
                    >
                      Run legacy
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => runSourcingEvaluation()} disabled={startingEvaluation}>
                    <RefreshCw className={cn("size-4", startingEvaluation && "animate-spin")} aria-hidden />
                    {startingEvaluation ? "Starting…" : evaluation ? "Re-run" : "Run evaluation"}
                  </Button>
                </div>
              ) : undefined
            }
          />
          {evaluationError && <p className="mb-3 text-sm font-medium text-danger">{evaluationError}</p>}

          {!evaluation && !evaluationError && (
            <p className="text-sm text-muted-foreground">
              Checks your own sales, the manifest&apos;s retail, store prices and demand outside eBay (Amazon sales,
              rank, reviews) to say whether things will sell and suggest a max bid, without any of eBay&apos;s data
              about other sellers.
            </p>
          )}

          {evaluation?.status === "running" && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                {evaluation.engine === "compliant"
                  ? "Evaluating — checking your own sales, retail, store prices and demand for each item. This can take several minutes for a large manifest…"
                  : "Evaluating with the legacy Analyzer — checking historical sales, live comps, and market signal for each item. This can take a couple minutes for a large manifest…"}
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
              {candidate.consignment ? (
                candidate.consignmentPickList && (
                  <ConsignmentPickListView
                    list={candidate.consignmentPickList}
                    title={candidate.title}
                    manifestId={candidate.id}
                  />
                )
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <Badge tone={evaluation.recommendation === "buy" ? "success" : "danger"} size="lg">
                      {evaluation.recommendation === "buy" ? "Buy" : "Don't buy"}
                    </Badge>
                    {evaluation.engine === "legacy" && (
                      <Badge tone="neutral" title="The original Analyzer, priced from other sellers' eBay listings">
                        Legacy Analyzer
                      </Badge>
                    )}
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
                </>
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
                          <MiniStat label={unitsLabel} value={String(e.effectiveUnits)} />
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
                          <th className="px-3 py-3 text-right">{unitsLabel}</th>
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

        {beta && evaluation?.status === "complete" && candidate.betaComparison && (
          <BetaComparisonCard
            legacy={candidate.betaComparison.evaluation}
            current={evaluation}
            legacyNote=" on the original manifest"
            unitsLabel={unitsLabel}
          />
        )}
        {!beta && evaluation?.status === "complete" && candidate.engineComparison && (
          <BetaComparisonCard
            legacy={evaluation.engine === "legacy" ? evaluation : candidate.engineComparison}
            current={evaluation.engine === "legacy" ? candidate.engineComparison : evaluation}
            legacyNote=""
            unitsLabel={unitsLabel}
          />
        )}

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

// The current Analyzer's call next to the legacy one's (on this manifest,
// or for a comparison copy on the manifest it was copied from), plus the
// products whose expected profit moved the most between the two. Products
// match by UPC (description when there's none).
function BetaComparisonCard({
  legacy,
  current,
  legacyNote,
  unitsLabel,
}: {
  legacy: CompareEvaluation | null;
  current: CompareEvaluation;
  // Where the legacy run came from, under the title.
  legacyNote: string;
  unitsLabel: string;
}) {
  const [showAll, setShowAll] = useState(false);
  // regular = the legacy run, beta = the current Analyzer's.
  const regular = legacy;
  const beta = current;
  if (!regular) {
    return (
      <Card>
        <SectionHeader title="Current vs legacy Analyzer" />
        <p className="text-sm text-muted-foreground">
          The original manifest has no finished legacy Analyzer run to compare with.
        </p>
      </Card>
    );
  }

  const keyOf = (e: { upc: string | null; description: string }) => e.upc ?? `desc:${e.description}`;
  const totalNet = (e: { estimatedNetPerUnit: number | null; effectiveUnits: number }) =>
    (e.estimatedNetPerUnit ?? 0) * e.effectiveUnits;
  const regularByKey = new Map(regular.lineEstimates.map((e) => [keyOf(e), e]));
  const rows = beta.lineEstimates
    .map((b) => {
      const r = regularByKey.get(keyOf(b));
      return r ? { b, r, diff: totalNet(b) - totalNet(r) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
  const priced = rows.filter(
    (x) => x.r.estimatedUnitSalePrice != null && x.b.estimatedUnitSalePrice != null && x.r.estimatedUnitSalePrice > 0
  );
  const closePrice = priced.filter(
    (x) => Math.abs(x.b.estimatedUnitSalePrice! - x.r.estimatedUnitSalePrice!) / x.r.estimatedUnitSalePrice! <= 0.25
  ).length;
  const newlyDud = rows.filter((x) => x.b.flaggedDud && !x.r.flaggedDud).length;
  const noLongerDud = rows.filter((x) => !x.b.flaggedDud && x.r.flaggedDud).length;
  const biggest = rows.slice().sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  const shown = showAll ? biggest : biggest.slice(0, 15);

  const call = (rec: "buy" | "dont_buy" | null) => (rec === "buy" ? "Buy" : rec === "dont_buy" ? "Don't buy" : "—");
  const dollars = (n: number | null) => (n != null ? money(n) : "—");
  const signed = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;
  const pct = (n: number | null) => (n != null ? `${(n * 100).toFixed(0)}%` : "—");

  return (
    <Card>
      <SectionHeader title="Current vs legacy Analyzer" />
      <p className="mb-3 text-xs text-muted-foreground">
        Legacy Analyzer run of {new Date(regular.startedAt).toLocaleDateString()}
        {legacyNote}.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-background">
            <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
              <th className="px-4 py-2.5" />
              <th className="px-3 py-2.5 text-right">Legacy</th>
              <th className="px-3 py-2.5 text-right">Current</th>
              <th className="px-4 py-2.5 text-right">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border tabular-nums">
            <tr>
              <td className="px-4 py-2.5 font-medium text-foreground">Call</td>
              <td className="px-3 text-right">{call(regular.recommendation)}</td>
              <td className="px-3 text-right">{call(beta.recommendation)}</td>
              <td className="px-4 text-right text-muted-foreground">
                {regular.recommendation === beta.recommendation ? "same" : "different"}
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-medium text-foreground">Max bid</td>
              <td className="px-3 text-right">{dollars(regular.maxBid)}</td>
              <td className="px-3 text-right">{dollars(beta.maxBid)}</td>
              <td className="px-4 text-right">
                {regular.maxBid != null && beta.maxBid != null ? signed(beta.maxBid - regular.maxBid) : "—"}
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-medium text-foreground">Expected net</td>
              <td className="px-3 text-right">{dollars(regular.expectedNetContribution)}</td>
              <td className="px-3 text-right">{dollars(beta.expectedNetContribution)}</td>
              <td className="px-4 text-right">
                {regular.expectedNetContribution != null && beta.expectedNetContribution != null
                  ? signed(beta.expectedNetContribution - regular.expectedNetContribution)
                  : "—"}
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 font-medium text-foreground">Likely duds</td>
              <td className="px-3 text-right">{pct(regular.dudShare)}</td>
              <td className="px-3 text-right">{pct(beta.dudShare)}</td>
              <td className="px-4 text-right text-muted-foreground">
                {newlyDud} new, {noLongerDud} cleared
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {priced.length > 0
          ? `${closePrice} of ${priced.length} products priced by both are within 25% of the legacy Analyzer's sale price.`
          : "No products were priced by both, so there's nothing to compare per product."}
      </p>

      {biggest.length > 0 && (
        <>
          <h3 className="mt-5 mb-2 text-sm font-semibold text-foreground">Biggest changes in expected profit</h3>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-background">
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                  <th className="px-4 py-2.5">Item</th>
                  <th className="px-3 py-2.5 text-right">Legacy sale/unit</th>
                  <th className="px-3 py-2.5 text-right">Current sale/unit</th>
                  <th className="px-3 py-2.5 text-right">{unitsLabel}</th>
                  <th className="px-4 py-2.5 text-right">Profit change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border tabular-nums">
                {shown.map(({ b, r, diff }) => (
                  <tr key={keyOf(b)}>
                    <td className="max-w-xs px-4 py-2.5">
                      <p className="truncate font-medium text-foreground">{b.description}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <ConfidenceBadge confidence={r.dataConfidence} />
                        <span className="text-xs text-muted-foreground">→</span>
                        <ConfidenceBadge confidence={b.dataConfidence} />
                        {b.flaggedDud && !r.flaggedDud && <Badge tone="warning">now dud</Badge>}
                        {!b.flaggedDud && r.flaggedDud && <Badge tone="success">no longer dud</Badge>}
                      </div>
                    </td>
                    <td className="px-3 text-right">{dollars(r.estimatedUnitSalePrice)}</td>
                    <td className="px-3 text-right">{dollars(b.estimatedUnitSalePrice)}</td>
                    <td className="px-3 text-right">{b.effectiveUnits}</td>
                    <td className={cn("px-4 text-right font-medium", diff >= 0 ? "text-success" : "text-danger")}>
                      {signed(diff)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {biggest.length > 15 && (
            <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)} className="mt-2 -ml-2">
              <ChevronDown className={cn("size-4 transition-transform", showAll && "rotate-180")} aria-hidden />
              {showAll ? "Show top 15" : `Show all ${biggest.length}`}
            </Button>
          )}
        </>
      )}
    </Card>
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
  exact_match: "primary",
  retail_estimate: "warning",
  unpriced: "neutral",
};

function ConfidenceBadge({ confidence }: { confidence: string }) {
  // replaceAll, not replace — "web_price_check" has two underscores, and the
  // old single replace() rendered it as "web price_check".
  return <Badge tone={CONFIDENCE_TONES[confidence] ?? "neutral"}>{confidence.replaceAll("_", " ")}</Badge>;
}

// Dud / slow-mover flags (and, on phones where there's no confidence
// column, the confidence badge) under an estimate's description.
// Banned is worked out from the description (lib/ebayBanned), so rows from
// evaluations that ran before it existed get labeled too.
function EstimateTags({ estimate: e, showConfidence = true }: { estimate: SourcingLineEstimate; showConfidence?: boolean }) {
  const banned = ebayBanReason(e.description);
  if (!e.flaggedDud && !e.slowMover && !e.longTail && !banned && !showConfidence) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {showConfidence && <ConfidenceBadge confidence={e.dataConfidence} />}
      {banned ? <Badge tone="danger">{banned}</Badge> : e.flaggedDud && <Badge tone="warning">dud</Badge>}
      {e.longTail && (
        <Badge tone="primary">
          slow, bonus · bid cheap
          {e.monthsToSellThrough != null ? ` · ~${e.monthsToSellThrough.toFixed(0)}mo to sell through` : ""}
        </Badge>
      )}
      {e.slowMover && (
        <Badge tone="purple">
          slow mover
          {e.monthsToSellThrough != null && e.monthsToSellThrough < 60
            ? ` · ~${e.monthsToSellThrough.toFixed(1)}mo to sell through`
            : e.sellRateSource === "ebay_listings"
              ? " · eBay listings show almost no sales"
              : ""}
          {e.sellRateSource === "ebay_listings" && e.monthsToSellThrough != null && e.monthsToSellThrough < 60
            ? " (from other sellers' listings)"
            : ""}
        </Badge>
      )}
    </div>
  );
}
