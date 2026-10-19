import { requireUser } from "@/lib/auth";
import { cleanLabelPayload, isLabelKind } from "@/components/labels/labelMarkup";
import { queuePrintJob } from "@/lib/warehouse/printJobs";
import { errorResponse, toPrintJobRow } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Queue labels to print at a station: bin and shelf labels from the Bins
// page, box barcodes from Settings, the station page's own test print.
// Body: { kind: "item" | "bin" | "shelf" | "box" | "dud" | "sort", payload, copies? }.
// Dud box labels from the sort station go through /api/dud-boxes, which
// builds the caption from the manifest; "dud" is accepted here too so a
// reprint from the print log works.
// Item labels from a save on the scan page are queued by the items API
// itself (inside its transaction), not through here.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(request);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    if (!isLabelKind(body.kind)) {
      return NextResponse.json({ error: 'kind must be "item", "bin", "shelf", "box", "dud" or "sort".' }, { status: 400 });
    }
    const cleaned = cleanLabelPayload(body.kind, body.payload);
    if ("error" in cleaned) return NextResponse.json({ error: cleaned.error }, { status: 400 });
    const copies = body.copies == null ? 1 : Number(body.copies);

    const job = await queuePrintJob({
      stationId: id,
      kind: body.kind,
      payload: cleaned.payload,
      copies,
      by: user.username,
    });
    return NextResponse.json(toPrintJobRow(job), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
