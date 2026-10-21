import { requireUser } from "@/lib/auth";
import { counterSaleError, CounterSaleError, refreshInvoice } from "@/lib/counterSale";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// The seller's screen polls this while an invoice waits: it asks Shopify,
// and once paid, records the sale. -> { id, state, status, customerEmail,
// shopifyOrderName, error }. Whoever made the sale, or the owner.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = requireUser(request);
    const { id } = await params;
    const sale = await prisma.counterSale.findUnique({ where: { id }, select: { soldBy: true } });
    if (!sale) throw new CounterSaleError("That sale doesn't exist.", 404);
    if (user.role !== "owner" && sale.soldBy !== user.username) throw new CounterSaleError("Not your sale.", 403);
    const { sale: s, state } = await refreshInvoice(id);
    return NextResponse.json({
      id: s.id,
      state,
      status: s.status,
      customerEmail: s.customerEmail,
      shopifyOrderName: s.shopifyOrderName,
      error: s.error,
    });
  } catch (e) {
    return counterSaleError(e);
  }
}
