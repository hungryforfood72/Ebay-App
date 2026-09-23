import { evaluateManifestChunk } from "@/lib/sourcingAgent";
import { prisma } from "@/lib/prisma";
import { after, NextRequest, NextResponse } from "next/server";
import { AuthError, requireOwner } from "@/lib/auth";

export const maxDuration = 180;

// A manifest with hundreds of unique UPCs can't finish inside one
// invocation's maxDuration (confirmed live: a 1036-group manifest got
// killed by Vercel at 180s with no error, leaving its SourcingEvaluation
// row stuck on "running" forever). This budget leaves a buffer before that
// hard kill for the final progress write and the self-triggered
// continuation fetch below — Vercel gives no warning before killing an
// invocation at maxDuration, so this has to be conservative, not tuned to
// the wire.
const CHUNK_BUDGET_MS = 150_000;
// Safety cap on how many times one evaluation can re-trigger itself — stops
// a genuinely stuck manifest (or a bug) from continuing forever instead of
// eventually failing loudly. 20 continuations × ~150s is up to 50 minutes
// of real work, generously more than even a much larger manifest than the
// one that prompted this.
const MAX_CONTINUATIONS = 20;

async function runChunk(evaluationId: string, manifestId: string, request: NextRequest) {
  const deadline = Date.now() + CHUNK_BUDGET_MS;

  // Throttled, fire-and-forget progress writes — evaluateManifestChunk's
  // callback fires once per line (up to ~1000+ for a huge manifest), and
  // awaiting a DB round-trip on every single one would slow the actual
  // work down for no benefit to a UI that only polls every 5s anyway.
  // Always let the final (processed === total) write through so the row
  // never gets stuck mid-progress if the last few calls land inside one
  // throttle window.
  let lastReportedAt = 0;
  function reportProgress(processedSteps: number, totalSteps: number) {
    const now = Date.now();
    const isFinal = processedSteps >= totalSteps;
    if (!isFinal && now - lastReportedAt < 700) return;
    lastReportedAt = now;
    prisma.sourcingEvaluation
      .update({ where: { id: evaluationId }, data: { processedSteps, totalSteps } })
      .catch((e) => console.error(`[sourcing-evaluate] manifest ${manifestId} progress update failed`, e));
  }

  try {
    const result = await evaluateManifestChunk(evaluationId, manifestId, deadline, reportProgress);

    if (!result.done) {
      const updated = await prisma.sourcingEvaluation.update({
        where: { id: evaluationId },
        data: { continuationCount: { increment: 1 } },
        select: { continuationCount: true },
      });
      if (updated.continuationCount > MAX_CONTINUATIONS) {
        await prisma.sourcingEvaluation.update({
          where: { id: evaluationId },
          data: {
            status: "failed",
            error: `Evaluation didn't finish after ${MAX_CONTINUATIONS} continuations (~${Math.round((MAX_CONTINUATIONS * CHUNK_BUDGET_MS) / 60000)} min of work) — something is likely stuck rather than just slow.`,
            completedAt: new Date(),
          },
        });
        return;
      }

      // Trigger a fresh invocation to pick up where this one left off — same
      // shared-secret pattern as the cron routes, since this is a
      // server-to-server call with no browser session to check. Only the
      // acknowledgement (202) is awaited, not the continuation's own work,
      // which runs in its own after() once that new invocation starts.
      const continueUrl = new URL(request.url);
      continueUrl.searchParams.set("continue", evaluationId);
      const res = await fetch(continueUrl.toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[sourcing-evaluate] manifest ${manifestId} failed to trigger continuation`, res.status, body);
        await prisma.sourcingEvaluation.update({
          where: { id: evaluationId },
          data: {
            status: "failed",
            error: "Evaluation stopped partway through and couldn't trigger its own continuation. Progress made so far was saved — retrying will resume from there, not start over.",
            completedAt: new Date(),
          },
        });
      }
      return;
    }

    await prisma.sourcingEvaluation.update({
      where: { id: evaluationId },
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
    });
  } catch (e) {
    console.error(`[sourcing-evaluate] manifest ${manifestId} failed`, e);
    await prisma.sourcingEvaluation.update({
      where: { id: evaluationId },
      data: {
        status: "failed",
        error: e instanceof Error ? e.message : "Evaluation failed.",
        completedAt: new Date(),
      },
    });
  }
}

// Kicks off (or continues) a pre-purchase sourcing evaluation for this
// manifest. A fresh start responds immediately with the new (running)
// evaluation; the real work happens in after() — same fire-and-forget
// pattern as AI item drafting (src/app/api/items/route.ts). The manifest
// detail page polls GET /api/manifests/[id] (which already embeds the
// latest evaluation) until status flips to "complete"/"failed". If one
// after() runs out of time before the manifest is fully processed, it
// saves what it finished and calls this same route again with ?continue=
// to pick up where it left off — see runChunk above and the resumability
// comment on evaluateManifestChunk in src/lib/sourcingAgent.ts.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const continueEvaluationId = request.nextUrl.searchParams.get("continue");

  if (continueEvaluationId) {
    if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const evaluation = await prisma.sourcingEvaluation.findUnique({ where: { id: continueEvaluationId } });
    if (!evaluation || evaluation.manifestId !== id || evaluation.status !== "running") {
      return NextResponse.json({ error: "Nothing to continue." }, { status: 404 });
    }
    after(() => runChunk(continueEvaluationId, id, request));
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  // Buy/don't-buy is squarely a bid decision — owner only, same as the
  // financial-data restriction on the rest of this manifest's numbers.
  try {
    requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const manifest = await prisma.manifest.findUnique({ where: { id }, select: { id: true } });
  if (!manifest) {
    return NextResponse.json({ error: "Manifest not found." }, { status: 404 });
  }

  const evaluation = await prisma.sourcingEvaluation.create({
    data: { manifestId: id, status: "running" },
  });

  after(() => runChunk(evaluation.id, id, request));

  return NextResponse.json(evaluation, { status: 202 });
}
