import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { PrintJobKind, PrintJobPayload } from "@/lib/warehouse/types";
import { queuePrintJob } from "@/lib/warehouse/printJobs";
import { errorResponse, toPrintJobRow } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Print a past job again (a label that jammed, smeared or got lost) as a
// new queued job, so the original keeps its own history.
// Body (all optional): { copies?: number, stationId?: string } to change
// how many or send it to a different station. Defaults: same as before.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(request);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const original = await prisma.printJob.findUnique({ where: { id } });
    if (!original) return NextResponse.json({ error: "That print job is gone." }, { status: 404 });

    const job = await queuePrintJob({
      stationId: typeof body.stationId === "string" && body.stationId ? body.stationId : original.stationId,
      kind: original.kind as PrintJobKind,
      payload: original.payload as PrintJobPayload,
      copies: body.copies == null ? original.copies : Number(body.copies),
      by: user.username,
    });
    return NextResponse.json(toPrintJobRow(job), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
