import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { stripShipTo } from "@/lib/warehouse/packingSlip";
import { toPrintJobRow } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// The station page reporting how a job it claimed went.
// Body: { status: "printed" | "failed", error?: string }.
// Any earlier status is accepted, on purpose: if the print log already gave
// up on a slow job and marked it failed, a late "printed" should still win.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (body.status !== "printed" && body.status !== "failed") {
    return NextResponse.json({ error: 'status must be "printed" or "failed".' }, { status: 400 });
  }
  const error = body.status === "failed" ? String(body.error ?? "Printing failed.").slice(0, 500) : null;
  const { count } = await prisma.printJob.updateMany({
    where: { id },
    data: { status: body.status, error, printedAt: body.status === "printed" ? new Date() : null },
  });
  if (count === 0) return NextResponse.json({ error: "That print job is gone." }, { status: 404 });
  let job = await prisma.printJob.findUnique({ where: { id } });
  // A packing slip's buyer address is only needed until it's on paper (or
  // the print failed and Reprint will read it fresh). Out of the saved copy
  // it comes, so the app doesn't keep buyer addresses.
  const payload = job?.payload as { html?: unknown } | null;
  if (job && job.kind === "packing_slip" && typeof payload?.html === "string" && payload.html.includes("<!--shipto-->")) {
    job = await prisma.printJob.update({
      where: { id },
      data: { payload: { ...(payload as object), html: stripShipTo(payload.html) } as Prisma.InputJsonValue },
    });
  }
  return NextResponse.json(job ? toPrintJobRow(job) : { ok: true });
}
