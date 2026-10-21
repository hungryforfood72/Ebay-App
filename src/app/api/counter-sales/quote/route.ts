import { requireUser } from "@/lib/auth";
import { counterSaleError, quoteSale } from "@/lib/counterSale";
import { NextRequest, NextResponse } from "next/server";

// The prices a sale will be checked against, in the unit it's sold in:
// GET ?kind=walkup|shelf&manifestId=&itemId=&upc=
// -> { description, packSize, ideal, nearExpiry, source }. No cost or floor
// in here: anyone with a scanner sees it.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    const p = request.nextUrl.searchParams;
    const q = await quoteSale({
      kind: p.get("kind") === "shelf" ? "shelf" : "walkup",
      manifestId: p.get("manifestId") || null,
      itemId: p.get("itemId") || null,
      upc: p.get("upc") ?? "",
    });
    return NextResponse.json({ description: q.description, packSize: q.packSize, ideal: q.ideal, nearExpiry: q.nearExpiry, source: q.source });
  } catch (e) {
    return counterSaleError(e);
  }
}
