import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ItemSaleError, recordItemSale } from "@/lib/walkupSale";
import { NextRequest, NextResponse } from "next/server";

// Records a "Sell Shelf Item" sale for an item that has no manifest to
// update (see GET /api/items/shelf-lookup's manifestId: null case) — when
// a manifest IS present, the client posts to the existing
// /api/manifests/[id]/walkup-sale route instead, which also updates that
// manifest's sold/profit numbers. There's nothing to update here beyond
// the Item/eBay listing itself, via the same recordItemSale logic that
// route uses.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const upc = String(body.upc ?? "").trim();
  const quantity = Number(body.quantity);
  const pricePerUnit = Number(body.pricePerUnit);

  if (!upc) {
    return NextResponse.json({ error: "UPC is required." }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity < 1) {
    return NextResponse.json({ error: "Quantity must be at least 1." }, { status: 400 });
  }
  if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
    return NextResponse.json({ error: "Price per unit must be a positive number." }, { status: 400 });
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item || item.upc !== upc) {
    return NextResponse.json({ error: "That item doesn't match this UPC." }, { status: 400 });
  }

  const recordedBy = getRequestUser(request)?.username ?? null;
  const roundedQuantity = Math.round(quantity);
  const note = `Shelf sale — ${roundedQuantity} unit(s) @ $${pricePerUnit.toFixed(2)} each, in person`;

  try {
    const { item: updatedItem, adjustment } = await recordItemSale(item, {
      quantity: roundedQuantity,
      pricePerUnit,
      note,
      recordedBy,
    });
    return NextResponse.json({ item: updatedItem, adjustment }, { status: 201 });
  } catch (e) {
    if (e instanceof ItemSaleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
