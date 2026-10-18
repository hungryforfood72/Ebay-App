import { runSourcingChunk } from "@/lib/sourcingRun";
import { prisma } from "@/lib/prisma";
import { after, NextRequest, NextResponse } from "next/server";
import { AuthError, requireOwner } from "@/lib/auth";

export const maxDuration = 180;

// Kicks off a pre-purchase sourcing evaluation for this manifest. Responds
// immediately with the (running) evaluation; the real work happens in
// after() — same fire-and-forget pattern as AI item drafting
// (src/app/api/items/route.ts). The analyzer page polls GET
// /api/manifests/[id] (which already embeds the latest evaluation) until
// status flips to "complete"/"failed". A manifest too big for one
// invocation continues itself chunk by chunk — see src/lib/sourcingRun.ts.
//
// If the latest evaluation failed partway through, this resumes it rather
// than starting over: every finished line is already saved (see
// evaluateManifestChunk), and redoing them would re-spend the Claude and
// web-search calls behind them for the same answer. After a completed
// evaluation, it starts a fresh one.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Buy/don't-buy is squarely a bid decision — owner only, same as the
  // financial-data restriction on the rest of this manifest's numbers.
  try {
    requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const manifest = await prisma.manifest.findUnique({ where: { id }, select: { id: true, analyzerBeta: true } });
  if (!manifest) {
    return NextResponse.json({ error: "Manifest not found." }, { status: 404 });
  }

  // The live Analyzer is the compliant one (2026-10-18); { engine: "legacy" }
  // runs the original comps-based one, which the page asks about first.
  // Comparison copies only ever run the compliant one.
  const body = await request.json().catch(() => ({}));
  const engine = body.engine === "legacy" && !manifest.analyzerBeta ? "legacy" : "compliant";

  const latest = await prisma.sourcingEvaluation.findFirst({
    where: { manifestId: id },
    orderBy: { startedAt: "desc" },
    include: { _count: { select: { lineEstimates: true } } },
  });

  // Resuming only continues the same Analyzer's run.
  const evaluation =
    latest?.status === "failed" && latest._count.lineEstimates > 0 && latest.engine === engine
      ? await prisma.sourcingEvaluation.update({
          where: { id: latest.id },
          data: { status: "running", error: null, completedAt: null, continuationCount: 0 },
        })
      : await prisma.sourcingEvaluation.create({ data: { manifestId: id, status: "running", engine } });

  const origin = request.nextUrl.origin;
  after(() => runSourcingChunk(evaluation.id, id, origin));

  return NextResponse.json(evaluation, { status: 202 });
}
