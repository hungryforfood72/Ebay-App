import { getRequestUser } from "@/lib/auth";
import { salesSummary } from "@/lib/salesSummary";
import { NextRequest, NextResponse } from "next/server";

// Sales for the dashboard's date-range picker: GET ?from=<ISO>&to=<ISO>,
// `to` exclusive, either one optional (open-ended). The client computes the
// bounds from its own local midnight, so "month to date" means the month in
// Chicago, not in the server's UTC.
//
// Owner only (Cristian, 2026-10-29): employees don't see any sales, not
// even units sold for a period. Blocked here, not just hidden on the page.
export async function GET(request: NextRequest) {
  if (getRequestUser(request)?.role !== "owner") {
    return NextResponse.json({ error: "Owner access required." }, { status: 403 });
  }
  const from = parseDate(request.nextUrl.searchParams.get("from"));
  const to = parseDate(request.nextUrl.searchParams.get("to"));
  if (from === undefined || to === undefined) {
    return NextResponse.json({ error: "Invalid date." }, { status: 400 });
  }
  if (from && to && from >= to) {
    return NextResponse.json({ error: "The start date has to be before the end date." }, { status: 400 });
  }

  const summary = await salesSummary(from, to);
  return NextResponse.json(summary);
}

// null = not given (open-ended), undefined = given but not a real date.
function parseDate(value: string | null): Date | null | undefined {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
