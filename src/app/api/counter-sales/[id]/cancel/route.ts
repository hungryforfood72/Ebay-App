import { requireUser } from "@/lib/auth";
import { cancelInvoice, counterSaleError } from "@/lib/counterSale";
import { NextRequest, NextResponse } from "next/server";

// The customer didn't pay: deletes the Shopify invoice, nothing is sold.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(request);
    const { id } = await params;
    const sale = await cancelInvoice(id, user);
    return NextResponse.json({ id: sale.id, status: sale.status });
  } catch (e) {
    return counterSaleError(e);
  }
}
