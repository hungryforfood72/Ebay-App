import { getSupplierReport } from "@/lib/supplierShare";
import { NextRequest, NextResponse } from "next/server";

// Public, read-only (proxy.ts lets /api/share/ through signed-out): the
// consignment supplier's report. The token in the URL is the only key.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const report = await getSupplierReport(token);
  if (!report) return NextResponse.json({ error: "This link isn't active." }, { status: 404 });
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
