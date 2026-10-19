import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { queuePrintJob } from "@/lib/warehouse/printJobs";
import { findSortBox } from "@/lib/warehouse/sortBoxes";
import { errorResponse, toPrintJobRow } from "@/lib/warehouse/stations";
import { sortBoxLabelPayload } from "@/lib/warehouse/sortStation";
import { NextRequest, NextResponse } from "next/server";

// Reprint one sort box's label (torn, lost): { stationId, copies? }. Anyone
// signed in.
export async function POST(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  try {
    const user = requireUser(request);
    const { code } = await params;
    const body = await request.json().catch(() => ({}));
    if (typeof body.stationId !== "string" || !body.stationId) {
      throw new WarehouseError("Pick the station to print at.");
    }
    const box = await findSortBox(prisma, code);
    const job = await queuePrintJob({
      stationId: body.stationId,
      kind: "sort",
      payload: sortBoxLabelPayload(box.code),
      copies: body.copies == null ? 1 : Number(body.copies),
      by: user.username,
    });
    return NextResponse.json(toPrintJobRow(job), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
