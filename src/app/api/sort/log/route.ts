import { requireUser } from "@/lib/auth";
import { errorResponse } from "@/lib/warehouse/stations";
import { logGood, nameExtra } from "@/lib/warehouse/sortStation";
import { after, NextRequest, NextResponse } from "next/server";

// "Good" at the sort station: { boxCode, manifestId, code, quantity, extra? }
// puts the units in the sorter's active sort box (boxCode null on a load
// sorted without boxes; box comes back null). code is what was scanned;
// the server matches it to the manifest line. Not on the manifest: refused
// unless extra: true ("Box it as extra").
// -> 201 { entry: { id, upc, quantity, extra, ... }, box: SortBoxSummary }
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    const result = await logGood({
      boxCode: body.boxCode == null ? null : String(body.boxCode),
      manifestId: String(body.manifestId ?? ""),
      code: String(body.code ?? ""),
      quantity: Number(body.quantity),
      extra: body.extra === true,
      by: user.username,
    });
    // Extras get a product name looked up for the manifest page, after the
    // response so the sorter isn't kept waiting.
    if (result.entry.extra) after(() => nameExtra(result.entry.id));
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
