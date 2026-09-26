import { evaluateManifestChunk } from "./sourcingAgent";
import { prisma } from "./prisma";

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

// Path the next chunk is triggered through. Under /api/cron/ on purpose:
// that's the one prefix proxy.ts lets through without a session (the call
// carries Bearer $CRON_SECRET instead, checked by the route). The first
// version called the sourcing-evaluate route itself, which proxy.ts turned
// away as "Not signed in" — so every manifest big enough to need a second
// chunk failed at the end of its first.
export const CONTINUE_PATH = "/api/cron/sourcing-continue";

// Runs one chunk of an evaluation (inside an after(), by both the route
// that starts an evaluation and the continuation route), then either
// finishes it or triggers the next chunk. `origin` is this deployment's
// own origin, for that trigger.
export async function runSourcingChunk(evaluationId: string, manifestId: string, origin: string) {
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
      .catch((e) => console.error(`[sourcing] manifest ${manifestId} progress update failed`, e));
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
            error: `Evaluation didn't finish after ${MAX_CONTINUATIONS} continuations (~${Math.round((MAX_CONTINUATIONS * CHUNK_BUDGET_MS) / 60000)} min of work) — something is likely stuck rather than just slow. Re-run picks up where it stopped.`,
            completedAt: new Date(),
          },
        });
        return;
      }

      // Only the acknowledgement (202) is awaited, not the next chunk's own
      // work, which runs in that new invocation's after().
      const continueUrl = new URL(CONTINUE_PATH, origin);
      continueUrl.searchParams.set("evaluation", evaluationId);
      const res = await fetch(continueUrl.toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[sourcing] manifest ${manifestId} failed to trigger continuation`, res.status, body);
        await prisma.sourcingEvaluation.update({
          where: { id: evaluationId },
          data: {
            status: "failed",
            error: `Evaluation stopped partway through and couldn't trigger its own continuation (HTTP ${res.status}). Progress so far is saved — Re-run picks up where it stopped.`,
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
    console.error(`[sourcing] manifest ${manifestId} failed`, e);
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
