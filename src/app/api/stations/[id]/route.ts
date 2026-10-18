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

// { packingSlips: true } makes this the station that prints packing slips
// and local delivery labels (and takes the job off any other station);
// false turns it off. Any signed-in user: it's set from the station PC.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (typeof body.packingSlips !== "boolean") return NextResponse.json({ error: "Send packingSlips: true or false." }, { status: 400 });
  const station = await prisma.station.findUnique({ where: { id }, select: { id: true } });
  if (!station) return NextResponse.json({ error: "That station doesn't exist anymore. Pick a station again." }, { status: 404 });
  const updated = await prisma.$transaction(async (tx) => {
    if (body.packingSlips) await tx.station.updateMany({ where: { id: { not: id }, packingSlips: true }, data: { packingSlips: false } });
    return tx.station.update({ where: { id }, data: { packingSlips: body.packingSlips }, select: STATION_STATUS_SELECT });
  });
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
