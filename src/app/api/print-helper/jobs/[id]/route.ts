import { finishPrintJob } from "@/lib/warehouse/printJobs";
import { stationForHelper } from "@/lib/warehouse/printHelper";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// The print helper reporting a job: { status: "printed" | "failed", error }.
// Its own station's jobs only.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const station = await stationForHelper(request);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    if (body.status !== "printed" && body.status !== "failed") {
      return NextResponse.json({ error: 'status must be "printed" or "failed".' }, { status: 400 });
    }
    const job = await finishPrintJob(id, body.status, body.status === "failed" ? String(body.error ?? "Printing failed.") : null, station.id);
    if (!job) return NextResponse.json({ error: "That print job is gone." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
