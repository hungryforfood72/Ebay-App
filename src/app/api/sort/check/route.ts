import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { errorResponse } from "@/lib/warehouse/stations";
import {
  DUD_ESTIMATE_SELECT,
  dudCall,
  latestCompleteEvaluationId,
  matchLineUpc,
  productCounts,
} from "@/lib/warehouse/sortCheck";
import { NextRequest, NextResponse } from "next/server";

// The sort station's scan: GET ?manifestId=&upc= -> what the manifest says
// about it and whether it's a dud, so the sorter only has to read one big
// answer. No money in here: sorters are usually employees.
//
// Without upc it just returns the load's title and whether the Analyzer
// ever ran on it (the sort page's header).
//
// {
//   manifest: { id, title }, evaluated,
//   line: { upc, description, expected, received, damaged, dud, leftToSort } | null,
//   dud, dudReason
// }
// line is null when the scan isn't on the manifest (dud is then false:
// there's no Analyzer call for something that wasn't on the load).
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    const params = request.nextUrl.searchParams;
    const manifestId = params.get("manifestId") ?? "";
    const scanned = (params.get("upc") ?? "").trim();

    const [manifest, evaluationId] = await Promise.all([
      manifestId
        ? prisma.manifest.findUnique({
            where: { id: manifestId },
            select: {
              id: true,
              title: true,
              lines: {
                select: { upc: true, description: true, expectedQuantity: true },
                orderBy: { sortOrder: "asc" },
              },
            },
          })
        : null,
      manifestId ? latestCompleteEvaluationId(manifestId) : null,
    ]);
    if (!manifest) throw new WarehouseError("That load doesn't exist anymore. Pick the load again.", 404);

    const base = { manifest: { id: manifest.id, title: manifest.title }, evaluated: evaluationId != null };
    if (!scanned) return NextResponse.json({ ...base, line: null, dud: false, dudReason: null });

    const upc = matchLineUpc(
      manifest.lines.map((l) => l.upc),
      scanned
    );
    if (!upc) return NextResponse.json({ ...base, line: null, dud: false, dudReason: null });

    // A UPC can be split across lines (pallets); the product is all of them.
    const lines = manifest.lines.filter((l) => l.upc === upc);
    const expected = lines.reduce((sum, l) => sum + l.expectedQuantity, 0);
    const [counts, estimate] = await Promise.all([
      productCounts(manifest.id, upc),
      evaluationId
        ? prisma.sourcingLineEstimate.findFirst({ where: { evaluationId, upc }, select: DUD_ESTIMATE_SELECT })
        : null,
    ]);
    const call = dudCall({ description: lines[0].description, evaluated: evaluationId != null, estimate });
    return NextResponse.json({
      ...base,
      line: {
        upc,
        description: lines[0].description,
        expected,
        ...counts,
        leftToSort: expected - counts.received - counts.damaged - counts.dud,
      },
      dud: call.dud,
      dudReason: call.reason,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
