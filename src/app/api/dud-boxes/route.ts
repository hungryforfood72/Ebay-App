import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { dudBoxLabelPayload, listDudBoxes } from "@/lib/warehouse/dudBoxReview";
import { createDudBox } from "@/lib/warehouse/dudBoxes";
import type { DudBoxStatus } from "@/lib/warehouse/dudBoxTypes";
import { queuePrintJob } from "@/lib/warehouse/printJobs";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

const STATUSES: DudBoxStatus[] = ["open", "closed", "done"];

// Dud boxes for the /duds page and the sort station.
// ?status=open,closed (any of open|closed|done; none = all)
// ?manifestId= (the sort station looking for an open box for its load)
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    const params = request.nextUrl.searchParams;
    const raw = params.get("status");
    const statuses = raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is DudBoxStatus => (STATUSES as string[]).includes(s))
      : null;
    const boxes = await listDudBoxes({ statuses, manifestId: params.get("manifestId") || null });
    return NextResponse.json({ boxes });
  } catch (e) {
    return errorResponse(e);
  }
}

// Start a dud box for a load at the sort station: { manifestId, stationId? }.
// With a station, its label prints there right away. The box is made even
// if the label can't be queued (station deleted, say): printError says
// why, and the sort page offers a reprint.
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    const manifestId = typeof body.manifestId === "string" ? body.manifestId : "";
    const stationId = typeof body.stationId === "string" && body.stationId ? body.stationId : null;
    const manifest = manifestId
      ? await prisma.manifest.findUnique({
          where: { id: manifestId },
          select: { id: true, title: true, purchased: true },
        })
      : null;
    if (!manifest) throw new WarehouseError("That load doesn't exist anymore. Pick the load again.", 404);
    if (!manifest.purchased) throw new WarehouseError("That load hasn't been bought yet, so there's nothing to sort.");

    const box = await createDudBox({ manifestId: manifest.id, by: user.username });
    let printed = false;
    let printError: string | null = null;
    if (stationId) {
      try {
        await queuePrintJob({
          stationId,
          kind: "dud",
          payload: dudBoxLabelPayload(box.code, manifest.title),
          by: user.username,
        });
        printed = true;
      } catch (e) {
        if (!(e instanceof WarehouseError)) throw e;
        printError = e.message;
      }
    }
    return NextResponse.json(
      {
        box: {
          code: box.code,
          status: box.status,
          manifestId: box.manifestId,
          manifestTitle: manifest.title,
          units: 0,
        },
        printed,
        printError,
      },
      { status: 201 }
    );
  } catch (e) {
    return errorResponse(e);
  }
}
