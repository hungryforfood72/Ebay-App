import { requireUser } from "@/lib/auth";
import { helperTokenFor } from "@/lib/warehouse/printHelper";
import { printHelperInstaller } from "@/lib/warehouse/printHelperInstaller";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Downloads the print helper installer for this station (a .cmd carrying
// the station's key; see printHelperInstaller.ts). Any signed-in user:
// it's done from the station PC.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireUser(request);
    const { id } = await params;
    const { token, name, slipPrinter } = await helperTokenFor(id);
    const body = printHelperInstaller({
      baseUrl: request.nextUrl.origin,
      stationId: id,
      stationName: name,
      token,
      browserStation: !slipPrinter,
    });
    const file = `Install print helper - ${name.replace(/[^A-Za-z0-9 ()_-]/g, "")}.cmd`;
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
