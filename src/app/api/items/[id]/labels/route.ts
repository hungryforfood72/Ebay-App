import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { buildItemLabel, queueItemLabels } from "@/lib/warehouse/itemLabel";
import { NextRequest, NextResponse } from "next/server";

// POST { stationId, copies? }: prints an item's label again at a station:
// the Rollo jammed, a label got smudged, or a bag lost its label in the bin.
// The label is rebuilt from the item the same way the first print was, so
// it reads the same. copies defaults to one per unit that hasn't sold
// (quantity - soldQuantity, at least 1). Not the bin count: items aren't
// in a bin until the binning station scans their labels, which is usually
// after a reprint would be needed.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const stationId = typeof body.stationId === "string" ? body.stationId : "";
  if (!stationId) return NextResponse.json({ error: "Pick a station to print at." }, { status: 400 });

  const item = await prisma.item.findUnique({
    where: { id },
    select: {
      id: true,
      sku: true,
      upc: true,
      manifestId: true,
      isBundle: true,
      isMultipack: true,
      packSize: true,
      expirationDate: true,
      condition: true,
      finalTitle: true,
      aiTitle: true,
      quantity: true,
      soldQuantity: true,
    },
  });
  if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });

  let copies: number;
  if (body.copies !== undefined && body.copies !== null && body.copies !== "") {
    copies = Number(body.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > 500) {
      return NextResponse.json({ error: "Copies must be a whole number from 1 to 500." }, { status: 400 });
    }
  } else {
    // At least one: asking to reprint should always print something.
    copies = Math.max(1, item.quantity - item.soldQuantity);
  }

  const payload = await buildItemLabel(prisma, item);
  try {
    const labelsQueued = await queueItemLabels(prisma, {
      stationId,
      payload,
      copies,
      by: getRequestUser(request)?.username ?? null,
    });
    return NextResponse.json({ labelsQueued, code: item.sku });
  } catch (e) {
    if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
