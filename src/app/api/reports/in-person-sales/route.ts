import { requireOwner } from "@/lib/auth";
import { counterSaleError } from "@/lib/counterSale";
import { getInPersonReport } from "@/lib/inPersonReport";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Owner only (also /api/reports in proxy.ts): GET ?days=30 -> InPersonReport.
export async function GET(request: NextRequest) {
  try {
    requireOwner(request);
    const days = Math.min(365, Math.max(1, Number(request.nextUrl.searchParams.get("days")) || 30));
    return NextResponse.json(await getInPersonReport(days));
  } catch (e) {
    return counterSaleError(e);
  }
}
