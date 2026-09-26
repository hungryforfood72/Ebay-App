import { prisma } from "@/lib/prisma";
import { runSourcingChunk } from "@/lib/sourcingRun";
import { after, NextRequest, NextResponse } from "next/server";

export const maxDuration = 180;

// Next chunk of a sourcing evaluation, triggered server-to-server by the
// previous chunk (src/lib/sourcingRun.ts) — not a scheduled cron, just
// under /api/cron/ so proxy.ts lets it through without a session. Same
// shared-secret check as the real cron routes.
export async function POST(request: NextRequest) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const evaluationId = request.nextUrl.searchParams.get("evaluation");
  const evaluation = evaluationId
    ? await prisma.sourcingEvaluation.findUnique({ where: { id: evaluationId } })
    : null;
  if (!evaluation || evaluation.status !== "running") {
    return NextResponse.json({ error: "Nothing to continue." }, { status: 404 });
  }
  const origin = request.nextUrl.origin;
  after(() => runSourcingChunk(evaluation.id, evaluation.manifestId, origin));
  return NextResponse.json({ ok: true }, { status: 202 });
}
