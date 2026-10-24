import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { callFor, consignmentCalls, returnedByUpc, returnedUnitsFor } from "@/lib/warehouse/consignmentSort";
import { errorResponse } from "@/lib/warehouse/stations";
import {
  DUD_ESTIMATE_SELECT,
  dudCall,
  latestCompleteEvaluationId,
  matchLineCode,
  productCounts,
  sortedUnitsFor,
} from "@/lib/warehouse/sortCheck";
import { sortedByUpc } from "@/lib/warehouse/sortBoxes";
import { lineKey } from "@/lib/upcMatch";
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
//   dud, dudReason, sortWithoutBoxes, itemNumberLines
// }
// line.upc is the line's key: the UPC, or "item:" + Item # for a product
// with no barcode (upc param can be an Item # typed in).
// Sorting counts physical units: sorted (good, in sort boxes) + damaged +
// dudLogged (every unit put in a dud box), against expected. received/dud
// are the listing-side reconciliation numbers (manifest page), kept for
// reference. line is null when the scan isn't on the manifest (dud is then
// false: there's no Analyzer call for something that wasn't on the load).
//
// Consignment loads (consignment: true) swap the dud call for the pick
// list's take/leave (consignmentCall, see consignmentSort.ts): dud is
// always false, expected only counts products to take (0 for leave), and
// line.returned is what's been set aside for the supplier. A scan not on
// the manifest goes back to the supplier too.
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
              consignment: true,
              sortWithoutBoxes: true,
              lines: {
                select: { id: true, upc: true, supplierSku: true, description: true, expectedQuantity: true },
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
      consignment: manifest.consignment,
      sortWithoutBoxes: manifest.sortWithoutBoxes,
      // Products with no UPC but an Item #: the page says to type the Item #.
      itemNumberLines: manifest.lines.filter((l) => !l.upc?.trim() && l.supplierSku?.trim()).length,
    };
    const none = { line: null, extraSorted: 0, dud: false, dudReason: null, consignmentCall: null };
    if (!scanned) {
      // Opening a consignment load builds its take/leave list now, so the
      // first scan doesn't wait on it.
      if (manifest.consignment) await consignmentCalls(manifest.id);
      return NextResponse.json({ ...base, ...none });
    }

    // The line's key: its UPC, or "item:" + Item # for a product with no
    // barcode (typed in by its Item #).
    const upc = matchLineCode(manifest.lines, scanned);
    if (!upc) {
      return NextResponse.json({
        ...base,
        ...none,
        extraSorted: sortedUnitsFor(await sortedByUpc(manifest.id), scanned, true),
      });
    }

    // A UPC can be split across lines (pallets); the product is all of them.
    const lines = manifest.lines.filter((l) => lineKey(l) === upc);
    const [counts, estimate, calls, returned] = await Promise.all([
      productCounts(manifest.id, upc),
      evaluationId && !manifest.consignment
        ? prisma.sourcingLineEstimate.findFirst({ where: { evaluationId, upc }, select: DUD_ESTIMATE_SELECT })
        : null,
      manifest.consignment ? consignmentCalls(manifest.id) : null,
      manifest.consignment ? returnedByUpc(manifest.id) : null,
    ]);
    const consignmentCall = manifest.consignment ? callFor(calls, upc) : null;
    const expected = consignmentCall?.decision === "leave" ? 0 : lines.reduce((sum, l) => sum + l.expectedQuantity, 0);
    const counted = counts.sorted + counts.damaged + counts.dudLogged;
    const call = manifest.consignment
      ? { dud: false, reason: null }
      : dudCall({ description: lines[0].description, evaluated: evaluationId != null, estimate });
    return NextResponse.json({
      ...base,
      line: {
        upc,
        description: lines[0].description,
        expected,
        ...counts,
        returned: returned ? returnedUnitsFor(returned, upc) : 0,
        leftToSort: Math.max(0, expected - counted),
        over: Math.max(0, counted - expected),
      },
      extraSorted: 0,
      dud: call.dud,
      dudReason: call.reason,
      consignmentCall,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
