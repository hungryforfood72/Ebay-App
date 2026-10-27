import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stationForUser } from "@/lib/stationSignIn";
import { adjustItemStock } from "@/lib/stockAdjust";
import { WarehouseError } from "@/lib/warehouse/bins";
import { classifyScan } from "@/lib/warehouse/codes";
import { buildItemLabel, queueItemLabels } from "@/lib/warehouse/itemLabel";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Restock a live warehouse listing from the Inventory page (Cristian,
// 2026-10-26): more of the same came in before the listing ended. Adds the
// units (the same live-checked stock change as Adjust: eBay, then Shopify)
// and prints a label for each one at the station you're signed in at, so
// they can be bagged and scanned into a bin like any other. Only from a
// station: no station, no labels, no restock.
// POST { amount, note? } -> the stock change's body + { labelsQueued, stationName }.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = requireUser(request);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 500) {
    return NextResponse.json({ error: "Enter how many came in (1 to 500)." }, { status: 400 });
  }

  const station = await stationForUser(request, user.id);
  if (!station) {
    return NextResponse.json(
      { error: "Sign in at the listing station first (scan the QR code on its screen), so the labels print there." },
      { status: 409 }
    );
  }

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
      manifestLineId: true,
      finalTitle: true,
      aiTitle: true,
      quantity: true,
      soldQuantity: true,
      status: true,
      listingEndedAt: true,
    },
  });
  if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });
  if (classifyScan(item.sku) !== "item") {
    return NextResponse.json({ error: "This listing has no warehouse label (old system). Use Adjust instead." }, { status: 400 });
  }
  if (item.status !== "listed" || item.listingEndedAt) {
    return NextResponse.json(
      { error: item.status === "sold" ? "This listing sold out and ended. List the new ones as a new listing." : "This listing isn't live anymore." },
      { status: 400 }
    );
  }

  const extra = typeof body.note === "string" && body.note.trim() ? `: ${body.note.trim()}` : "";
  const result = await adjustItemStock({
    itemId: id,
    direction: "add",
    amount,
    note: `Restock, ${amount} more (labels at ${station.name})${extra}`,
    recordedBy: user.username,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // The stock is already up on eBay: a label problem must not hide that.
  // The Inventory page offers Print again for this.
  try {
    const payload = await buildItemLabel(prisma, item);
    const labelsQueued = await queueItemLabels(prisma, { stationId: station.id, payload, copies: amount, by: user.username });
    return NextResponse.json({ ...result.body, labelsQueued, stationId: station.id, stationName: station.name });
  } catch (e) {
    const labelError = e instanceof WarehouseError || e instanceof Error ? e.message : "Couldn't print the labels.";
    return NextResponse.json({ ...result.body, labelsQueued: 0, labelError, stationId: station.id, stationName: station.name });
  }
}
