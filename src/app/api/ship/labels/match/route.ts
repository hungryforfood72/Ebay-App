import { requireUser } from "@/lib/auth";
import { matchPages, type PageRead } from "@/lib/warehouse/shippingLabels";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// { pages: [{ text, barcodes }] }, read from the PDF in the browser. Says
// which eBay order(s) each page ships, by the tracking number on it. The
// text (it has the buyer's address) is only used here, never saved.
export async function POST(request: NextRequest) {
  try {
    requireUser(request);
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.pages) || body.pages.length === 0 || body.pages.length > 300) {
      return NextResponse.json({ error: "Send 1 to 300 pages." }, { status: 400 });
    }
    const pages: PageRead[] = body.pages.map((p: { text?: unknown; barcodes?: unknown }) => ({
      text: typeof p?.text === "string" ? p.text.slice(0, 20_000) : "",
      barcodes: Array.isArray(p?.barcodes) ? p.barcodes.filter((x: unknown): x is string => typeof x === "string").slice(0, 10) : [],
    }));
    return NextResponse.json({ matches: await matchPages(pages) });
  } catch (e) {
    return errorResponse(e);
  }
}
