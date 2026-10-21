import { prisma } from "@/lib/prisma";
import { stationForHelper } from "@/lib/warehouse/printHelper";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// The print helper checking in every ~10s: { printers: string[], version }
// -> what it should do: { stationId, name, printerName, paused }. It only
// prints once a printer is picked on the station page. A slip printer
// station (no browser) counts as online through this too.
export async function POST(request: NextRequest) {
  try {
    const station = await stationForHelper(request);
    const body = await request.json().catch(() => ({}));
    const sent: unknown[] = Array.isArray(body.printers) ? body.printers : [];
    const printers = Array.isArray(body.printers)
      ? [...new Set(sent.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 200))].slice(0, 100)
      : station.printers;
    const now = new Date();
    await prisma.station.update({
      where: { id: station.id },
      data: {
        printers,
        helperSeenAt: now,
        helperVersion: typeof body.version === "string" ? body.version.slice(0, 40) : null,
        ...(station.slipPrinter ? { lastSeenAt: now } : {}),
      },
    });
    return NextResponse.json({
      stationId: station.id,
      name: station.name,
      printerName: station.printerName,
      paused: station.printPaused,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
