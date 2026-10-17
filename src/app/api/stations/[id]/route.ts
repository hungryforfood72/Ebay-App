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

// Owner only. Its queued and past print jobs go with it (cascade).
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const { count } = await prisma.station.deleteMany({ where: { id } });
  if (count === 0) return NextResponse.json({ error: "That station is already gone." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
