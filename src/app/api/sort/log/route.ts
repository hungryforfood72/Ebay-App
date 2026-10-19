import { requireUser } from "@/lib/auth";
import { errorResponse } from "@/lib/warehouse/stations";
import { logGood } from "@/lib/warehouse/sortStation";
import { NextRequest, NextResponse } from "next/server";

// "Good" at the sort station: { boxCode, manifestId, code, quantity, extra? }
// puts the units in the sorter's active sort box. code is what was scanned;
// the server matches it to the manifest line. Not on the manifest: refused
// unless extra: true ("Box it as extra").
// -> 201 { entry: { id, upc, quantity, extra, ... }, box: SortBoxSummary }
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    const result = await logGood({
      boxCode: String(body.boxCode ?? ""),
      manifestId: String(body.manifestId ?? ""),
      code: String(body.code ?? ""),
      quantity: Number(body.quantity),
      extra: body.extra === true,
      by: user.username,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
