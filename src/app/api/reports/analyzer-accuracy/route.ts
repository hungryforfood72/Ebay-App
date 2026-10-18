import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ACCURACY_KNOWLEDGE_SCOPE, runPredictionTracker } from "@/lib/predictionTracker";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// GET: the Analyzer's report card (src/lib/predictionTracker.ts), refreshed
// every 4 hours by the full-sync cron.
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;

  // ?analyzer=legacy for the original Analyzer's report card; the live
  // (compliant) one by default.
  const analyzer = request.nextUrl.searchParams.get("analyzer") === "legacy" ? "legacy" : "compliant";
  const [outcomes, calibration, lessons, legacyOutcomes, copyOutcomes] = await Promise.all([
    prisma.predictionOutcome.findMany({
      where: { variant: analyzer },
      include: { manifest: { select: { title: true, betaSourceId: true } } },
      orderBy: [{ soldUnits: "desc" }, { listedUnits: "desc" }],
    }),
    prisma.sourcingCalibration.findMany(),
    prisma.sourcingKnowledge.findUnique({ where: { scope: ACCURACY_KNOWLEDGE_SCOPE } }),
    prisma.predictionOutcome.findMany({ where: { variant: "legacy" } }),
    prisma.predictionOutcome.findMany({
      where: { variant: "compliant", manifest: { analyzerBeta: true } },
      include: { manifest: { select: { betaSourceId: true } } },
    }),
  ]);
  // A comparison copy's rows sit under the copy; report them under the load
  // they were copied from, so the manifest filter groups them with it.
  const sourceTitles = new Map(
    (
      await prisma.manifest.findMany({
        where: { id: { in: [...new Set(outcomes.map((o) => o.manifest.betaSourceId).filter((id): id is string => id != null))] } },
        select: { id: true, title: true },
      })
    ).map((m) => [m.id, m.title])
  );

  const prefix = analyzer === "compliant" ? "compliant_" : "";
  return NextResponse.json({
    analyzer,
    calibration: calibration
      .filter((c) => (prefix ? c.kind.startsWith(prefix) : !c.kind.includes("_")))
      .map((c) => ({ ...c, kind: c.kind.replace(prefix, "") })),
    lessons: lessons ? { notes: lessons.notes, updatedAt: lessons.updatedAt } : null,
    betaVsRegular: betaVsRegular(legacyOutcomes, copyOutcomes),
    outcomes: outcomes.map((o) => ({
      id: o.id,
      manifestId: o.manifest.betaSourceId ?? o.manifestId,
      manifestTitle: (o.manifest.betaSourceId && sourceTitles.get(o.manifest.betaSourceId)) || o.manifest.title,
      upc: o.upc,
      description: o.description,
      evaluatedAt: o.evaluatedAt,
      dataConfidence: o.dataConfidence,
      sellRateSource: o.sellRateSource,
      predictedDud: o.predictedDud,
      predictedUnitPrice: o.predictedUnitPrice != null ? Number(o.predictedUnitPrice) : null,
      predictedUnitsPerMonth: o.predictedUnitsPerMonth,
      expectedUnits: o.expectedUnits,
      listedUnits: o.listedUnits,
      soldUnits: o.soldUnits,
      dudUnits: o.dudUnits,
      actualUnitPrice: o.actualUnitPrice != null ? Number(o.actualUnitPrice) : null,
      actualNetPerUnit: o.actualNetPerUnit != null ? Number(o.actualNetPerUnit) : null,
      monthsActive: o.monthsActive,
      actualUnitsPerMonth: o.actualUnitsPerMonth,
      priceRatio: o.priceRatio,
      speedRatio: o.speedRatio,
      updatedAt: o.updatedAt,
    })),
  });
}

type ScoredOutcome = {
  manifestId: string;
  upc: string;
  predictedDud: boolean;
  priceRatio: number | null;
  soldUnits: number;
  listedUnits: number;
  monthsActive: number | null;
};

// The live (compliant) Analyzer against the legacy one on the same products
// of the same bought loads, from comparison copies (Analyzer Beta, see
// src/lib/predictionTracker.ts): how far off each one's price was, and how
// many of its dud / will-sell calls real sales proved wrong. null until a
// compared load has listings.
function betaVsRegular(regular: ScoredOutcome[], beta: (ScoredOutcome & { manifest: { betaSourceId: string | null } })[]) {
  const regularByKey = new Map(regular.map((o) => [`${o.manifestId}|${o.upc}`, o]));
  const pairs = beta
    .map((b) => ({ b, r: regularByKey.get(`${b.manifest.betaSourceId}|${b.upc}`) }))
    .filter((p): p is { b: (typeof beta)[number]; r: ScoredOutcome } => p.r != null && p.r.listedUnits + p.r.soldUnits > 0);
  if (pairs.length === 0) return null;

  const medianMissPct = (ratios: number[]) => {
    if (ratios.length === 0) return null;
    const misses = ratios.map((r) => Math.abs(Math.log(r))).sort((a, b) => a - b);
    return Math.round((Math.exp(misses[Math.floor(misses.length / 2)]) - 1) * 100);
  };
  const priced = pairs.filter((p) => p.b.priceRatio && p.r.priceRatio);
  const score = (pick: (p: (typeof pairs)[number]) => ScoredOutcome) => ({
    medianPriceMissPct: medianMissPct(priced.map((p) => pick(p).priceRatio!)),
    dudsThatSold: pairs.filter((p) => pick(p).predictedDud && p.r.soldUnits > 0).length,
    dudCalls: pairs.filter((p) => pick(p).predictedDud).length,
    // Expected to sell, but nothing sold after a month or more of listing.
    stuck: pairs.filter((p) => !pick(p).predictedDud && p.r.listedUnits > 0 && p.r.soldUnits === 0 && (p.r.monthsActive ?? 0) >= 1).length,
  });
  return {
    products: pairs.length,
    withSales: pairs.filter((p) => p.r.soldUnits > 0).length,
    pricedByBoth: priced.length,
    regular: score((p) => p.r),
    beta: score((p) => p.b),
  };
}

// POST: refresh now instead of waiting for the cron.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const result = await runPredictionTracker();
  return NextResponse.json(result);
}
