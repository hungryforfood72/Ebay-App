import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// The station page asking "anything to print?". Returns queued jobs oldest
// first and flips them to "printing" in the same statement, so if the
// station page is open in two tabs only one of them gets each job (SKIP
// LOCKED makes the other tab's poll pass over rows being claimed instead of
// waiting on them). The page then reports back through PATCH
// /api/print-jobs/{id}.
//
// One query whether or not there's anything waiting: this runs every
// 1.5-5 seconds all day. At most 20 jobs per poll (written into the SQL as
// a literal: a bound parameter can arrive as numeric, which LIMIT rejects).
type ClaimedRow = { id: string; kind: string; payload: unknown; copies: number; createdAt: Date };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "PrintJob" SET status = 'printing'
    WHERE id IN (
      SELECT id FROM "PrintJob"
      WHERE "stationId" = ${id} AND status = 'queued'
      ORDER BY "createdAt" ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, payload, copies, "createdAt"`;

  // RETURNING doesn't promise any order.
  rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      // Raw queries can hand jsonb back as text depending on the driver.
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      copies: r.copies,
      createdAt: new Date(r.createdAt).toISOString(),
    }))
  );
}
