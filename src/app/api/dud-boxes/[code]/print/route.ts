import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { dudBoxLabelPayload } from "@/lib/warehouse/dudBoxReview";
import { findDudBox } from "@/lib/warehouse/dudBoxes";
import { queuePrintJob } from "@/lib/warehouse/printJobs";
import { errorResponse, toPrintJobRow } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Reprint a dud box's label: { stationId, copies? }. Same label as when it
// was made (code + "DUDS · {load}").
export async function POST(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  try {
    const user = requireUser(request);
    const { code } = await params;
    const body = await request.json().catch(() => ({}));
    if (typeof body.stationId !== "string" || !body.stationId) {
      throw new WarehouseError("Pick the station to print at.");
    }
    const box = await findDudBox(prisma, code);
    const manifest = await prisma.manifest.findUniqueOrThrow({
      where: { id: box.manifestId },
      select: { title: true },
    });
    const job = await queuePrintJob({
      stationId: body.stationId,
      kind: "dud",
      payload: dudBoxLabelPayload(box.code, manifest.title),
      copies: body.copies == null ? 1 : Number(body.copies),
      by: user.username,
    });
    return NextResponse.json(toPrintJobRow(job), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
