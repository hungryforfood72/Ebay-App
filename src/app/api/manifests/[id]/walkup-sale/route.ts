import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Records an in-person, cash, no-fee/no-shipping sale straight out of a
// manifest — same tally pattern as .../damaged and .../duds, plus the real
// negotiated price. recordedBy comes from the signed-in session (not the
// request body) so it can't be spoofed, same fix already applied to
// StockAdjustment this session.
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

  const recordedBy = getRequestUser(request)?.username ?? null;

  const entry = await prisma.manifestWalkupSale.create({
    data: {
      manifestId: id,
      upc,
      quantity: Math.round(quantity),
      pricePerUnit,
      note: body.note ?? null,
      recordedBy,
    },
  });

  return NextResponse.json(entry, { status: 201 });
}
