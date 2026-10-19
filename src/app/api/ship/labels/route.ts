import { logActivity } from "@/lib/activityLog";
import { requireUser } from "@/lib/auth";
import { deleteBatch, listLabels, saveLabelPage } from "@/lib/warehouse/shippingLabels";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Shipping labels uploaded from eBay's bulk label PDF (see
// warehouse/shippingLabels.ts).
// GET: the last week's labels, for the list on Pick orders.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    return NextResponse.json({ labels: await listLabels() });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST: one page, after /api/ship/labels/match. One request per page keeps
// each under Vercel's body limit.
// { batchId, page, trackingNumber, carrier, orderIds, widthIn, heightIn, image (PNG data URL) }
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const b = await request.json().catch(() => ({}));
    if (
      typeof b.batchId !== "string" ||
      !Number.isInteger(b.page) ||
      typeof b.image !== "string" ||
      !Array.isArray(b.orderIds) ||
      typeof b.widthIn !== "number" ||
      typeof b.heightIn !== "number"
    ) {
      return NextResponse.json({ error: "Send batchId, page, orderIds, widthIn, heightIn and image." }, { status: 400 });
    }
    const saved = await saveLabelPage({
      batchId: b.batchId.slice(0, 64),
      page: b.page,
      trackingNumber: typeof b.trackingNumber === "string" ? b.trackingNumber : null,
      carrier: typeof b.carrier === "string" ? b.carrier.slice(0, 40) : null,
      orderIds: b.orderIds.filter((x: unknown): x is string => typeof x === "string"),
      imageBase64: b.image,
      widthIn: b.widthIn,
      heightIn: b.heightIn,
      by: user.username,
    });
    await logActivity(
      { request, user },
      {
        action: "shipping_label.upload",
        summary: `Label page ${b.page}${b.orderIds.length ? ` for ${b.orderIds.join(", ")}` : " (not matched)"}${saved.replaced ? ", replaced" : ""}`,
        targetType: "shipping_label",
        targetId: saved.id,
      }
    );
    return NextResponse.json(saved, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE ?batch=: takes a whole upload back out (wrong PDF).
export async function DELETE(request: NextRequest) {
  try {
    requireUser(request);
    const batch = request.nextUrl.searchParams.get("batch");
    if (!batch) return NextResponse.json({ error: "Send batch." }, { status: 400 });
    const deleted = await deleteBatch(batch);
    await logActivity({ request }, { action: "shipping_label.delete", summary: `Removed an upload of ${deleted} label page${deleted === 1 ? "" : "s"}` });
    return NextResponse.json({ deleted });
  } catch (e) {
    return errorResponse(e);
  }
}
