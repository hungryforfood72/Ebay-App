import { logActivity } from "@/lib/activityLog";
import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { STATION_STATUS_SELECT, toStationStatus } from "@/lib/warehouse/stations";
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
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const data: { packingSlips?: boolean; printerName?: string | null; printPaused?: boolean } = {};
  if (typeof body.packingSlips === "boolean") data.packingSlips = body.packingSlips;
  if (typeof body.printPaused === "boolean") data.printPaused = body.printPaused;
  if (body.printerName === null || typeof body.printerName === "string") data.printerName = body.printerName || null;
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Send packingSlips, printerName or printPaused." }, { status: 400 });
  }
  const station = await prisma.station.findUnique({ where: { id }, select: { id: true, printers: true } });
  if (!station) return NextResponse.json({ error: "That station doesn't exist anymore. Pick a station again." }, { status: 404 });
  if (data.printerName && !station.printers.includes(data.printerName)) {
    return NextResponse.json({ error: "That printer isn't on this station's PC." }, { status: 400 });
  }
  const updated = await prisma.$transaction(async (tx) => {
    if (data.packingSlips) await tx.station.updateMany({ where: { id: { not: id }, packingSlips: true }, data: { packingSlips: false } });
    return tx.station.update({ where: { id }, data, select: STATION_STATUS_SELECT });
  });
  const summary = [
    data.packingSlips !== undefined ? `packing slips ${data.packingSlips ? "on" : "off"}` : null,
    data.printerName !== undefined ? `4x6 printer ${data.printerName ?? "none (page prints)"}` : null,
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
