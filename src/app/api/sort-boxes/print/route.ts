import { ownerOnly, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { queuePrintJob } from "@/lib/warehouse/printJobs";
import { errorResponse } from "@/lib/warehouse/stations";
import { sortBoxCodesInRange, sortBoxLabelPayload } from "@/lib/warehouse/sortStation";
import { NextRequest, NextResponse } from "next/server";

const MAX_LABELS = 200;

// Print labels for a range of sort boxes at a station, owner only:
// { from: "SB0001", to: "SB0040", stationId } -> 201 { printed: [codes] }.
// One print job per box (each label is a different barcode), all queued in
// one transaction so a missing station fails before anything is queued.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    if (typeof body.stationId !== "string" || !body.stationId) {
      throw new WarehouseError("Pick the station to print at.");
    }
    const codes = await sortBoxCodesInRange(String(body.from ?? ""), String(body.to ?? ""));
    if (codes.length === 0) throw new WarehouseError("No sort boxes in that range.");
    if (codes.length > MAX_LABELS) {
      throw new WarehouseError(`That's ${codes.length} labels. Print ${MAX_LABELS} or fewer at a time.`);
    }
    await prisma.$transaction(async (tx) => {
      for (const code of codes) {
        await queuePrintJob(
          { stationId: body.stationId, kind: "sort", payload: sortBoxLabelPayload(code), by: user.username },
          tx
        );
      }
    });
    return NextResponse.json({ printed: codes }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
