import { getRequestUser } from "@/lib/auth";
import { startRun } from "@/lib/delivery/deliveries";
import { deliveryErrorResponse } from "@/lib/delivery/http";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Start deliveries: { ids, start: { lat, lng } | null, endAtStart }.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown): x is string => typeof x === "string") : [];
  const lat = Number(body.start?.lat);
  const lng = Number(body.start?.lng);
  const start = Number.isFinite(lat) && Number.isFinite(lng) && body.start != null ? { lat, lng } : null;
  try {
    const run = await startRun({ ids, start, endAtStart: body.endAtStart === true, driver: getRequestUser(request)?.username ?? null });
    return NextResponse.json({ runId: run.id });
  } catch (e) {
    return deliveryErrorResponse(e, "start run");
  }
}
