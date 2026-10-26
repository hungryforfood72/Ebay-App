import { AuthError, requireUser } from "@/lib/auth";
import { getPullList } from "@/lib/warehouse/pulls";
import { NextRequest, NextResponse } from "next/server";

// What staff still need to pull off shelves / out of bins: listings that
// came off eBay for their date, or because the package says Rx Only
// (pullReason "rx_return"). Same list as the Dashboard's, small enough for
// the List page to check on the scanner (Cristian, 2026-10-25), and what
// the Pull page (/pulls) works through, in walking order. Any signed-in
// user; no money in it. GET -> { items: PullItem[] } (src/lib/warehouse/pulls.ts).
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json({ items: await getPullList() });
}
