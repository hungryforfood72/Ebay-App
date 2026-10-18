import { markLabelPrinted } from "@/lib/delivery/deliveries";
import { NextRequest, NextResponse } from "next/server";

// The page printed these labels (it can't tell if paper came out, only
// that the print was sent).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((x: unknown): x is string => typeof x === "string") : [];
  await markLabelPrinted(ids);
  return NextResponse.json({ ok: true });
}
