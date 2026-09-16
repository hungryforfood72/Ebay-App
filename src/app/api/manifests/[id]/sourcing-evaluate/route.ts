import { evaluateManifest } from "@/lib/sourcingAgent";
import { prisma } from "@/lib/prisma";
import { after, NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";

export const maxDuration = 180;

// Kicks off a pre-purchase sourcing evaluation for this manifest. Responds
// immediately with the new (running) evaluation; the real work happens in
// after() — same fire-and-forget pattern as AI item drafting
// (src/app/api/items/route.ts) — so it isn't bound by the response itself,
// only by maxDuration. The manifest detail page polls GET
// /api/manifests/[id] (which already embeds the latest evaluation) until
// status flips to "complete"/"failed".
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const manifest = await prisma.manifest.findUnique({ where: { id }, select: { id: true } });
  if (!manifest) {
    return NextResponse.json({ error: "Manifest not found." }, { status: 404 });
  }

  const evaluation = await prisma.sourcingEvaluation.create({
    data: { manifestId: id, status: "running" },
  });

  after(async () => {
    try {
      const result = await evaluateManifest(id);
      await prisma.$transaction([
        prisma.sourcingEvaluation.update({
          where: { id: evaluation.id },
          data: {
            status: "complete",
            recommendation: result.recommendation,
            maxBid: result.maxBid,
            expectedNetContribution: result.expectedNetContribution,
            dudShare: result.dudShare,
            concentrationRisk: result.concentrationRisk,
            reasoning: result.reasoning,
            completedAt: new Date(),
          },
        }),
        prisma.sourcingLineEstimate.createMany({
          data: result.lineEstimates.map((e) => ({
            evaluationId: evaluation.id,
            upc: e.upc,
            description: e.description,
            extendedRetail: e.extendedRetail,
            estimatedUnitSalePrice: e.estimatedUnitSalePrice,
            estimatedUnitFees: e.estimatedUnitFees,
            estimatedUnitShipping: e.estimatedUnitShipping,
            estimatedNetPerUnit: e.estimatedNetPerUnit,
            effectiveUnits: e.effectiveUnits,
            typicalPackSize: e.typicalPackSize,
            dataConfidence: e.dataConfidence,
            flaggedDud: e.flaggedDud,
          })) satisfies Prisma.SourcingLineEstimateCreateManyInput[],
        }),
      ]);
    } catch (e) {
      console.error(`[sourcing-evaluate] manifest ${id} failed`, e);
      await prisma.sourcingEvaluation.update({
        where: { id: evaluation.id },
        data: {
          status: "failed",
          error: e instanceof Error ? e.message : "Evaluation failed.",
          completedAt: new Date(),
        },
      });
    }
  });

  return NextResponse.json(evaluation, { status: 202 });
}
