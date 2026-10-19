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
  sortedUnitsFor,
} from "@/lib/warehouse/sortCheck";
import { sortedByUpc } from "@/lib/warehouse/sortBoxes";
import { NextRequest, NextResponse } from "next/server";

// The sort station's scan: GET ?manifestId=&upc= -> what the manifest says
// about it and whether it's a dud, so the sorter only has to read one big
// answer. No money in here: sorters are usually employees.
//
// Without upc it just returns the load's header: title, whether the
// Analyzer ever ran on it, and whether sorting was marked finished.
//
// {
//   manifest: { id, title, sortedAt, sortedBy }, evaluated,
//   line: { upc, description, expected, sorted, damaged, dudLogged,
//           leftToSort, over, received, dud } | null,
//   extraSorted,   // not on the manifest: units of it already boxed as extra
//   dud, dudReason
// }
// Sorting counts physical units: sorted (good, in sort boxes) + damaged +
// dudLogged (every unit put in a dud box), against expected. received/dud
// are the listing-side reconciliation numbers (manifest page), kept for
// reference. line is null when the scan isn't on the manifest (dud is then
// false: there's no Analyzer call for something that wasn't on the load).
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
              sortedAt: true,
              sortedBy: true,
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

    const base = {
      manifest: { id: manifest.id, title: manifest.title, sortedAt: manifest.sortedAt, sortedBy: manifest.sortedBy },
      evaluated: evaluationId != null,
    };
    const none = { line: null, extraSorted: 0, dud: false, dudReason: null };
    if (!scanned) return NextResponse.json({ ...base, ...none });

    const upc = matchLineUpc(
      manifest.lines.map((l) => l.upc),
      scanned
    );
    if (!upc) {
      return NextResponse.json({
        ...base,
        ...none,
        extraSorted: sortedUnitsFor(await sortedByUpc(manifest.id), scanned, true),
      });
    }

    // A UPC can be split across lines (pallets); the product is all of them.
    const lines = manifest.lines.filter((l) => l.upc === upc);
    const expected = lines.reduce((sum, l) => sum + l.expectedQuantity, 0);
    const [counts, estimate] = await Promise.all([
      productCounts(manifest.id, upc),
      evaluationId
        ? prisma.sourcingLineEstimate.findFirst({ where: { evaluationId, upc }, select: DUD_ESTIMATE_SELECT })
        : null,
    ]);
    const counted = counts.sorted + counts.damaged + counts.dudLogged;
    const call = dudCall({ description: lines[0].description, evaluated: evaluationId != null, estimate });
    return NextResponse.json({
      ...base,
      line: {
        upc,
        description: lines[0].description,
        expected,
        ...counts,
        leftToSort: Math.max(0, expected - counted),
        over: Math.max(0, counted - expected),
      },
      extraSorted: 0,
      dud: call.dud,
      dudReason: call.reason,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
