import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { queuePrintJob } from "@/lib/warehouse/printJobs";
import { startSortBox } from "@/lib/warehouse/sortBoxes";
import { getSortBoxSummary, listSortBoxes, sortBoxLabelPayload } from "@/lib/warehouse/sortStation";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Sort boxes (SB0001...): GET lists every box with its load and the units
// still in it. No money, so anyone signed in.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    return NextResponse.json({ boxes: await listSortBoxes() });
  } catch (e) {
    return errorResponse(e);
  }
}

// Start a new sort box for a load at the sort station, same as a dud box
// (boxes aren't reused since 2026-11-01): { manifestId, stationId? }. With a
// station, its label prints there right away, naming the load. The box is
// made even if the label can't be queued: printError says why, and the
// sort page offers a reprint. -> 201 { box: SortBoxSummary, printed, printError }
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    const manifestId = typeof body.manifestId === "string" ? body.manifestId : "";
    const stationId = typeof body.stationId === "string" && body.stationId ? body.stationId : null;
    const manifest = manifestId
      ? await prisma.manifest.findUnique({
          where: { id: manifestId },
          select: { id: true, title: true, purchased: true, sortWithoutBoxes: true },
        })
      : null;
    if (!manifest) throw new WarehouseError("That load doesn't exist anymore. Pick the load again.", 404);
    if (!manifest.purchased) throw new WarehouseError("That load hasn't been bought yet, so there's nothing to sort.");
    if (manifest.sortWithoutBoxes) throw new WarehouseError("This load is sorted without boxes.", 409);

    const box = await startSortBox({ manifestId: manifest.id });
    let printed = false;
    let printError: string | null = null;
    if (stationId) {
      try {
        await queuePrintJob({
          stationId,
          kind: "sort",
          payload: sortBoxLabelPayload(box.code, manifest.title),
          by: user.username,
        });
        printed = true;
      } catch (e) {
        if (!(e instanceof WarehouseError)) throw e;
        printError = e.message;
      }
    }
    return NextResponse.json({ box: await getSortBoxSummary(box.code), printed, printError }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
