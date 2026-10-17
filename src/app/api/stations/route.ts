import { ownerOnly, requireUser } from "@/lib/auth";
import { naturalSort } from "@/lib/naturalSort";
import { prisma } from "@/lib/prisma";
import { STATION_STATUS_SELECT, errorResponse, toStationStatus } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Listing stations (a PC with the scale and label printer, see
// src/app/station/[id]). Anyone signed in can list them, since handhelds
// pick their station from this; only the owner adds or removes them.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    const rows = await prisma.station.findMany({ select: STATION_STATUS_SELECT });
    const now = Date.now();
    // Natural order so "Station 2" comes before "Station 10".
    return NextResponse.json(naturalSort(rows, (s) => s.name).map((s) => toStationStatus(s, now)));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return NextResponse.json({ error: "Give the station a name." }, { status: 400 });
  if (name.length > 40) return NextResponse.json({ error: "Keep the name under 40 characters." }, { status: 400 });

  // Names are unique in the DB, but "station 1" vs "Station 1" would still
  // confuse whoever picks one on a handheld.
  const clash = await prisma.station.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (clash) return NextResponse.json({ error: `There's already a station called "${name}".` }, { status: 409 });

  const station = await prisma.station.create({ data: { name }, select: STATION_STATUS_SELECT });
  return NextResponse.json(toStationStatus(station), { status: 201 });
}
