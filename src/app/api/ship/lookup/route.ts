import { describeScan } from "@/lib/warehouse/picking";
import { NextRequest, NextResponse } from "next/server";

// What a scanned label or UPC is, for when /ship gets a scan that no open
// order needs: "That's ES000456 (Neutrogena 3-pack, exp 05/2027)".
// item is null when the app has nothing with that code.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim();
  if (!code) return NextResponse.json({ error: "Send ?code=" }, { status: 400 });
  return NextResponse.json({ item: await describeScan(code) });
}
