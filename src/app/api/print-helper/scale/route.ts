import { prisma } from "@/lib/prisma";
import { helperScaleData, stationForHelper } from "@/lib/warehouse/printHelper";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// The print helper's scale reading, sent the moment it changes (at most ~4
// a second): { status, weightOz, stable }. Check-ins carry it too, every
// 10s, so a scale sitting still stays fresh. See helperScaleData.
export async function POST(request: NextRequest) {
  try {
    const station = await stationForHelper(request);
    const body = await request.json().catch(() => ({}));
    const data = helperScaleData(body, station, new Date());
    if (data) await prisma.station.update({ where: { id: station.id }, data });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
