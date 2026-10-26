import { requireUser } from "@/lib/auth";
import { pullScan } from "@/lib/warehouse/pulls";
import { NextRequest, NextResponse } from "next/server";

// One scan on the Pull page (src/lib/warehouse/pulls.ts):
//   { scannedCode, binCode? }        an item's label (or UPC, old system)
//   { itemId, manual: true }         "Found it" on one with nothing to scan
// A wrong scan is a 200 with ok: false, like picking.
export async function POST(request: NextRequest) {
  const user = requireUser(request);
  const body = await request.json().catch(() => ({}));
  if (typeof body.scannedCode !== "string" && body.manual !== true) {
    return NextResponse.json({ error: "Send scannedCode, or itemId with manual: true." }, { status: 400 });
  }
  try {
    const result = await pullScan(
      {
        scannedCode: typeof body.scannedCode === "string" ? body.scannedCode : "",
        binCode: typeof body.binCode === "string" ? body.binCode : null,
        itemId: typeof body.itemId === "string" ? body.itemId : null,
        manual: body.manual === true,
      },
      user.username
    );
    return NextResponse.json(result);
  } catch (e) {
    console.error("[pulls/scan]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't save that." }, { status: 502 });
  }
}
