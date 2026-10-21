import { prisma } from "@/lib/prisma";
import { stationForHelper } from "@/lib/warehouse/printHelper";
import { labelImage } from "@/lib/warehouse/shippingLabels";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// A shipping label's PNG for the print helper (the label page loads it from
// the app). Only a label that was sent to the helper's own station.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const station = await stationForHelper(request);
    const { id } = await params;
    const sent = await prisma.printJob.findFirst({
      where: { stationId: station.id, kind: "shipping_label", payload: { path: ["html"], string_contains: `/api/ship/labels/${id}/image` } },
      select: { id: true },
    });
    if (!sent) return NextResponse.json({ error: "That label wasn't sent to this station." }, { status: 404 });
    const image = await labelImage(id);
    if (!image) return NextResponse.json({ error: "That label isn't kept anymore." }, { status: 404 });
    return new NextResponse(Buffer.from(image), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
