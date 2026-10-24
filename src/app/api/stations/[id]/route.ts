import { logActivity } from "@/lib/activityLog";
import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { STATION_STATUS_SELECT, toStationStatus } from "@/lib/warehouse/stations";
import { LABEL_SIZES, isLabelSize, type LabelSize } from "@/lib/warehouse/types";
import { NextRequest, NextResponse } from "next/server";

// One station's status. Handhelds poll this about once a second during the
// weight step, so it's a single primary-key lookup and nothing else.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const station = await prisma.station.findUnique({ where: { id }, select: STATION_STATUS_SELECT });
  if (!station) {
    return NextResponse.json({ error: "That station doesn't exist anymore. Pick a station again." }, { status: 404 });
  }
  return NextResponse.json(toStationStatus(station));
}

// Station settings, from the station PC (any signed-in user), any of:
//   packingSlips: true makes this the station that prints packing slips
//     and local delivery labels (and takes the job off any other station)
//   printerName: the printer its print helper prints 4x6 pages on (one the
//     helper reported), or null to hand them back to the page
//   printPaused: Print automatically off/on
//   labelSize: the stock the small code labels print on (LABEL_SIZES)
//   labelPrinterName: the printer its print helper prints the small
//     labels on (one the helper reported), or null for the page
//   checkForUpdate: true asks the print helper to update itself now
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const data: {
    packingSlips?: boolean;
    printerName?: string | null;
    printPaused?: boolean;
    labelSize?: LabelSize;
    labelPrinterName?: string | null;
    helperUpdateAt?: Date;
  } = {};
  if (typeof body.packingSlips === "boolean") data.packingSlips = body.packingSlips;
  if (typeof body.printPaused === "boolean") data.printPaused = body.printPaused;
  if (body.printerName === null || typeof body.printerName === "string") data.printerName = body.printerName || null;
  if (body.labelPrinterName === null || typeof body.labelPrinterName === "string") data.labelPrinterName = body.labelPrinterName || null;
  if (body.checkForUpdate === true) data.helperUpdateAt = new Date();
  if (body.labelSize !== undefined) {
    if (!isLabelSize(body.labelSize)) return NextResponse.json({ error: "That label size isn't one of the choices." }, { status: 400 });
    data.labelSize = body.labelSize;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Send packingSlips, printerName, labelSize, labelPrinterName, checkForUpdate or printPaused." }, { status: 400 });
  }
  const station = await prisma.station.findUnique({ where: { id }, select: { id: true, printers: true } });
  if (!station) return NextResponse.json({ error: "That station doesn't exist anymore. Pick a station again." }, { status: 404 });
  for (const name of [data.printerName, data.labelPrinterName]) {
    if (name && !station.printers.includes(name)) {
      return NextResponse.json({ error: "That printer isn't on this station's PC." }, { status: 400 });
    }
  }
  const updated = await prisma.$transaction(async (tx) => {
    if (data.packingSlips) await tx.station.updateMany({ where: { id: { not: id }, packingSlips: true }, data: { packingSlips: false } });
    return tx.station.update({ where: { id }, data, select: STATION_STATUS_SELECT });
  });
  const summary = [
    data.packingSlips !== undefined ? `packing slips ${data.packingSlips ? "on" : "off"}` : null,
    data.printerName !== undefined ? `4x6 printer ${data.printerName ?? "none (page prints)"}` : null,
    data.labelSize !== undefined ? `label size ${LABEL_SIZES[data.labelSize].name}` : null,
    data.labelPrinterName !== undefined ? `label printer ${data.labelPrinterName ?? "none (page prints)"}` : null,
    data.helperUpdateAt ? "asked the print helper to check for updates" : null,
    data.printPaused !== undefined ? `printing ${data.printPaused ? "paused" : "on"}` : null,
  ].filter(Boolean).join(", ");
  await logActivity({ request }, { action: "setting", summary: `${updated.name}: ${summary}`, targetType: "station", targetId: id, after: data });
  return NextResponse.json(toStationStatus(updated));
}

// Owner only. Its queued and past print jobs go with it (cascade).
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const { count } = await prisma.station.deleteMany({ where: { id } });
  if (count === 0) return NextResponse.json({ error: "That station is already gone." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
