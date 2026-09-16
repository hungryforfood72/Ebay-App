import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Records a tally of units that physically arrived in good condition but
// won't be listed on eBay at all (dead licensed/seasonal merch, no
// realistic resale value, etc.) — not an item, just a count so the
// reconciliation dashboard can account for why something never made it to
// review, same role ManifestDamagedEntry plays for actually-damaged units.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const upc = String(body.upc ?? "").trim();
  const quantity = Number(body.quantity);

  if (!upc) {
    return NextResponse.json({ error: "UPC is required." }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity < 1) {
    return NextResponse.json({ error: "Quantity must be at least 1." }, { status: 400 });
  }

  const entry = await prisma.manifestDudEntry.create({
    data: {
      manifestId: id,
      upc,
      quantity: Math.round(quantity),
      note: body.note ?? null,
      recordedBy: body.recordedBy ?? null,
    },
  });

  return NextResponse.json(entry, { status: 201 });
}
