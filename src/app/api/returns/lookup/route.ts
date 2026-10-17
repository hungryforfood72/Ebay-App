import { WarehouseError } from "@/lib/warehouse/bins";
import { findReturnCandidates } from "@/lib/warehouse/returns";
import { NextRequest, NextResponse } from "next/server";

// GET ?code= — the listing(s) a returned item could be: its item label
// (ES code) finds the one listing, a UPC finds that product's listings that
// sold something, most recent sale first. Each comes with its recent sales
// so the page can ask which order it came back from. No money in it.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") ?? "";
  try {
    const items = await findReturnCandidates(code);
    if (items.length === 0) {
      return NextResponse.json({ error: "Nothing sold with that label or UPC. Check the code." }, { status: 404 });
    }
    return NextResponse.json({ items });
  } catch (e) {
    if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
