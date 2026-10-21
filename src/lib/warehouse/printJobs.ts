import { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { WarehouseError } from "./bins";
import { stripShipTo } from "./packingSlip";
import { PAGE_JOB_KINDS, type PrintJobKind, type PrintJobPayload } from "./types";

// Queues labels for a station PC to print. The station page (/station/{id})
// polls for queued jobs and prints them on its Rollo.
export async function queuePrintJob(
  args: {
    stationId: string;
    kind: PrintJobKind;
    payload: PrintJobPayload;
    copies?: number;
    by: string | null;
  },
  tx: Prisma.TransactionClient | typeof prisma = prisma
) {
  const copies = args.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 200) {
    throw new WarehouseError("Copies must be between 1 and 200.");
  }
  const station = await tx.station.findUnique({ where: { id: args.stationId }, select: { id: true } });
  if (!station) throw new WarehouseError("That station doesn't exist anymore. Pick a station again.", 404);
  return tx.printJob.create({
    data: {
      stationId: args.stationId,
      kind: args.kind,
      payload: args.payload as Prisma.InputJsonValue,
      copies,
      createdBy: args.by,
    },
  });
}

// Hands out a station's queued jobs: oldest first, flipped to "printing" in
// the same statement, so two pollers (two tabs, or the page and the print
// helper) never get the same job (SKIP LOCKED passes over rows another
// poll is claiming). which: "page" = the 4x6 pages (the print helper's),
// "label" = the small code labels (the station page's while a helper is
// printing the pages). Nothing while the station's printing is paused.
// At most 20 per call (a literal: a bound parameter can arrive as numeric,
// which LIMIT rejects).
export type ClaimedJob = { id: string; kind: string; payload: unknown; copies: number; createdAt: string };

export async function claimJobs(stationId: string, which: "all" | "page" | "label"): Promise<ClaimedJob[]> {
  const pages = Prisma.join([...PAGE_JOB_KINDS]);
  const kindFilter =
    which === "page" ? Prisma.sql`AND kind IN (${pages})` : which === "label" ? Prisma.sql`AND kind NOT IN (${pages})` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: string; kind: string; payload: unknown; copies: number; createdAt: Date }[]>`
    UPDATE "PrintJob" SET status = 'printing'
    WHERE id IN (
      SELECT id FROM "PrintJob"
      WHERE "stationId" = ${stationId} AND status = 'queued' ${kindFilter}
        AND NOT EXISTS (SELECT 1 FROM "Station" WHERE id = ${stationId} AND "printPaused")
      ORDER BY "createdAt" ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, payload, copies, "createdAt"`;
  // RETURNING doesn't promise any order.
  rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    // Raw queries can hand jsonb back as text depending on the driver.
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    copies: r.copies,
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

// How a claimed job went. Any earlier status is accepted, on purpose: if
// the print log already gave up on a slow job and marked it failed, a late
// "printed" should still win. stationId (the print helper): only that
// station's jobs. null = the job is gone (or not this station's).
export async function finishPrintJob(id: string, status: "printed" | "failed", error: string | null, stationId?: string) {
  const { count } = await prisma.printJob.updateMany({
    where: { id, ...(stationId ? { stationId } : {}) },
    data: { status, error: status === "failed" ? (error ?? "Printing failed.").slice(0, 500) : null, printedAt: status === "printed" ? new Date() : null },
  });
  if (count === 0) return null;
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
  return job;
}
