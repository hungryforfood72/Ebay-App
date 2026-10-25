import { prisma } from "@/lib/prisma";
import { stationForHelper } from "@/lib/warehouse/printHelper";
import { errorResponse } from "@/lib/warehouse/stations";
import { labelSizeOf } from "@/lib/warehouse/types";
import { NextRequest, NextResponse } from "next/server";

// The print helper checking in every ~10s: { printers: string[], version }
// -> what it should do: { stationId, name, printerName, labelPrinterName,
// labelSize, paused, checkUpdate }. It only prints once a printer is picked on the
// station page (4x6 pages on printerName, small labels on
// labelPrinterName). A slip printer station (no browser) counts as online
// through this too. checkUpdate: "Check for updates" was pressed on the
// station page; the helper fetches its latest version right away.
// Also { version: "installer" } from the installer, { error } from a
// helper that can't start, and { scalePolicy } (the PC's Chrome scale
// policy, see Station.scalePolicy).
export async function POST(request: NextRequest) {
  try {
    const station = await stationForHelper(request);
    const body = await request.json().catch(() => ({}));
    const sent: unknown[] = Array.isArray(body.printers) ? body.printers : [];
    const printers = Array.isArray(body.printers)
      ? [...new Set(sent.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 200))].slice(0, 100)
      : station.printers;
    const now = new Date();
    const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
    const error = typeof body.error === "string" && body.error.trim() ? body.error.slice(-2000) : null;
    const scalePolicy = typeof body.scalePolicy === "string" ? body.scalePolicy.slice(0, 20) : undefined;
    // The installer's check-in, or a helper reporting why it can't run:
    // the printer list and the error, but not "running" (helperSeenAt).
    const notRunning = version === "installer" || error != null;
    await prisma.station.update({
      where: { id: station.id },
      data: {
        printers,
        ...(scalePolicy !== undefined ? { scalePolicy } : {}),
        ...(notRunning
          ? {
              ...(version === "installer" ? { helperInstalledAt: now } : {}),
              ...(error ? { helperError: error, helperErrorAt: now } : {}),
            }
          : {
              helperSeenAt: now,
              helperVersion: version,
              ...(station.helperError ? { helperError: null, helperErrorAt: null } : {}),
              ...(station.slipPrinter ? { lastSeenAt: now } : {}),
              ...(station.helperUpdateAt ? { helperUpdateAt: null } : {}),
            }),
      },
    });
    return NextResponse.json({
      stationId: station.id,
      name: station.name,
      printerName: station.printerName,
      labelPrinterName: station.labelPrinterName,
      labelSize: labelSizeOf(station.labelSize),
      paused: station.printPaused,
      checkUpdate: station.helperUpdateAt != null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
