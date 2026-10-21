import { claimJobs } from "@/lib/warehouse/printJobs";
import { stationForHelper } from "@/lib/warehouse/printHelper";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// The print helper taking its station's 4x6 pages (packing slips, shipping
// and delivery labels). Nothing until a printer is picked, so the station
// page keeps printing everything until then.
export async function GET(request: NextRequest) {
  try {
    const station = await stationForHelper(request);
    if (!station.printerName) return NextResponse.json([]);
    return NextResponse.json(await claimJobs(station.id, "page"));
  } catch (e) {
    return errorResponse(e);
  }
}
