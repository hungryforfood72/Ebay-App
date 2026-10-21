import { requireOwner } from "@/lib/auth";
import { counterSaleError } from "@/lib/counterSale";
import { setReviewed } from "@/lib/inPersonReport";
import { NextRequest, NextResponse } from "next/server";

// Owner only: { reviewed: true | false } on a flagged sale.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = requireOwner(request);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await setReviewed(id, body.reviewed !== false, user.username));
  } catch (e) {
    return counterSaleError(e);
  }
}
