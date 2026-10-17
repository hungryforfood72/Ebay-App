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

  const [outcomes, calibration, lessons] = await Promise.all([
    prisma.predictionOutcome.findMany({
      include: { manifest: { select: { title: true } } },
      orderBy: [{ soldUnits: "desc" }, { listedUnits: "desc" }],
    }),
    prisma.sourcingCalibration.findMany(),
    prisma.sourcingKnowledge.findUnique({ where: { scope: ACCURACY_KNOWLEDGE_SCOPE } }),
  ]);

  return NextResponse.json({
    calibration,
    lessons: lessons ? { notes: lessons.notes, updatedAt: lessons.updatedAt } : null,
    outcomes: outcomes.map((o) => ({
      id: o.id,
      manifestId: o.manifestId,
      manifestTitle: o.manifest.title,
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

// POST: refresh now instead of waiting for the cron.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const result = await runPredictionTracker();
  return NextResponse.json(result);
}
