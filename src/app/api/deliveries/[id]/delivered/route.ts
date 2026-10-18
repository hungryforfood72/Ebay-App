import { getRequestUser } from "@/lib/auth";
import { markDelivered } from "@/lib/delivery/deliveries";
import { deliveryErrorResponse } from "@/lib/delivery/http";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// { code: the label barcode scanned at the door, photoUrl }. Records the
// drop-off, then fulfills on Shopify and emails the photo.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (typeof body.code !== "string" || typeof body.photoUrl !== "string") {
    return NextResponse.json({ error: "Scan the label and take the photo first." }, { status: 400 });
  }
  try {
    const delivery = await markDelivered({ id, code: body.code, photoUrl: body.photoUrl, by: getRequestUser(request)?.username ?? null });
    return NextResponse.json({ delivery });
  } catch (e) {
    return deliveryErrorResponse(e, "delivered");
  }
}
