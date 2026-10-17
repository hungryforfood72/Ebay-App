import { WarehouseError } from "@/lib/warehouse/bins";
import { returnListingPlan } from "@/lib/warehouse/returns";
import { NextResponse } from "next/server";

// The scan page's /scan?return={id}: what to prefill for listing a
// not-the-same return in its real condition. 400 once it's been listed.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await returnListingPlan(id));
  } catch (e) {
    if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
