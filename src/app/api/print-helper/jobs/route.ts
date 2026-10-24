import { isLabelKind, labelsDocument } from "@/components/labels/labelMarkup";
import { claimJobs } from "@/lib/warehouse/printJobs";
import { stationForHelper } from "@/lib/warehouse/printHelper";
import { errorResponse } from "@/lib/warehouse/stations";
import { LABEL_SIZES, helperCanPrintLabels, labelSizeOf, type PrintJobPayload } from "@/lib/warehouse/types";
import { NextRequest, NextResponse } from "next/server";

// The print helper taking its station's jobs: the 4x6 pages (packing
// slips, shipping and delivery labels) once a 4x6 printer is picked, the
// small code labels once a label printer is picked. Whatever has no printer
// picked stays for the station page.
//
// Each job says where it goes (target "page" | "label"). A label job comes
// with its printable html at the station's label size, one copy (the helper
// prints copies), and the size in inches for picking the paper.
export async function GET(request: NextRequest) {
  try {
    const station = await stationForHelper(request);
    const pages = station.printerName != null;
    const labels = station.labelPrinterName != null && helperCanPrintLabels(station.helperVersion);
    if (!pages && !labels) return NextResponse.json([]);
    const jobs = await claimJobs(station.id, pages && labels ? "all" : pages ? "page" : "label");
    const size = labelSizeOf(station.labelSize);
    const { width, height } = LABEL_SIZES[size];
    return NextResponse.json(
      jobs.map((job) => {
        if (!isLabelKind(job.kind)) return { ...job, target: "page" };
        const payload = job.payload as PrintJobPayload;
        return {
          ...job,
          target: "label",
          payload: { ...payload, html: labelsDocument([{ kind: job.kind, payload }], size) },
          size: { width, height },
        };
      })
    );
  } catch (e) {
    return errorResponse(e);
  }
}
