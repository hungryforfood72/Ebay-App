import { ownerOnly } from "@/lib/auth";
import { sortCountReport } from "@/lib/warehouse/sortCountReport";
import { NextRequest, NextResponse } from "next/server";

// GET ?days= -> sortCountReport(days): "Count was off" fixes by sorter, by
// who reported them, and each fix. Owner only.
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const days = Math.min(365, Math.max(1, Number(request.nextUrl.searchParams.get("days") ?? 90) || 90));
  return NextResponse.json(await sortCountReport(days));
}
