import { requireUser } from "@/lib/auth";
import { labelImage } from "@/lib/warehouse/shippingLabels";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// The label page as a PNG: what the packing station prints, and the
// thumbnail on Pick orders. Never cached: it's the buyer's address.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireUser(request);
    const { id } = await params;
    const image = await labelImage(id);
    if (!image) return NextResponse.json({ error: "That label isn't kept anymore. Upload the PDF again." }, { status: 404 });
    return new NextResponse(Buffer.from(image), {
      headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
