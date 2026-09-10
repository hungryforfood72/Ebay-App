import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Units actually received for an item = the quantity scanned, times pack
// size if it's a multipack — the same "3 of a 2-pack = 6 units" accounting
// Cristian described. Bundles have no single UPC and can't be matched to a
// manifest line, so they're excluded from reconciliation entirely.
function unitsFor(item: { quantity: number; isMultipack: boolean; packSize: number | null }): number {
  return item.quantity * (item.isMultipack && item.packSize ? item.packSize : 1);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const manifest = await prisma.manifest.findUnique({
    where: { id },
    include: {
      lines: true,
      damaged: true,
      items: {
        select: { upc: true, quantity: true, isMultipack: true, packSize: true, isBundle: true },
      },
    },
  });
  if (!manifest) {
    return NextResponse.json({ error: "Manifest not found." }, { status: 404 });
  }

  const receivedByUpc = new Map<string, number>();
  const unmatchedReceived: { upc: string | null; units: number }[] = [];
  for (const item of manifest.items) {
    if (item.isBundle || !item.upc) continue;
    const units = unitsFor(item);
    receivedByUpc.set(item.upc, (receivedByUpc.get(item.upc) ?? 0) + units);
  }

  const damagedByUpc = new Map<string, number>();
  for (const d of manifest.damaged) {
    damagedByUpc.set(d.upc, (damagedByUpc.get(d.upc) ?? 0) + d.quantity);
  }

  const totalManifestExtendedRetail = manifest.lines.reduce(
    (sum, l) => sum + Number(l.extendedRetail),
    0
  );
  const totalLandedCost = manifest.totalLandedCost != null ? Number(manifest.totalLandedCost) : null;

  const matchedUpcs = new Set<string>();
  const lines = manifest.lines.map((line) => {
    const receivedUnits = line.upc ? receivedByUpc.get(line.upc) ?? 0 : 0;
    const damagedUnits = line.upc ? damagedByUpc.get(line.upc) ?? 0 : 0;
    if (line.upc) matchedUpcs.add(line.upc);

    // This line's proportional share of the load's total declared value —
    // used to weight the shared landed cost, so a pricier line absorbs more
    // of the freight/fee cost than a cheap one rather than splitting evenly.
    const valueShare = totalManifestExtendedRetail > 0 ? Number(line.extendedRetail) / totalManifestExtendedRetail : 0;
    const weightedCogsPerUnit =
      totalLandedCost != null && line.expectedQuantity > 0
        ? (valueShare * totalLandedCost) / line.expectedQuantity
        : null;

    return {
      id: line.id,
      supplierSku: line.supplierSku,
      upc: line.upc,
      description: line.description,
      expectedQuantity: line.expectedQuantity,
      retailPrice: Number(line.retailPrice),
      extendedRetail: Number(line.extendedRetail),
      condition: line.condition,
      category: line.category,
      subcategory: line.subcategory,
      receivedUnits,
      damagedUnits,
      accountedUnits: receivedUnits + damagedUnits,
      missingUnits: line.expectedQuantity - (receivedUnits + damagedUnits),
      weightedCogsPerUnit,
    };
  });

  // Received/damaged units whose UPC isn't on the manifest at all — extra or
  // mis-scanned items, worth surfacing rather than silently dropping.
  for (const [upc, units] of receivedByUpc) {
    if (!matchedUpcs.has(upc)) unmatchedReceived.push({ upc, units });
  }
  const unmatchedDamaged: { upc: string | null; units: number }[] = [];
  for (const [upc, units] of damagedByUpc) {
    if (!matchedUpcs.has(upc)) unmatchedDamaged.push({ upc, units });
  }

  const totalExpectedUnits = lines.reduce((sum, l) => sum + l.expectedQuantity, 0);
  const totalReceivedUnits = lines.reduce((sum, l) => sum + l.receivedUnits, 0) +
    unmatchedReceived.reduce((sum, u) => sum + u.units, 0);
  const totalDamagedUnits = lines.reduce((sum, l) => sum + l.damagedUnits, 0) +
    unmatchedDamaged.reduce((sum, u) => sum + u.units, 0);

  const blendedCogsPerUnit =
    totalLandedCost != null && totalReceivedUnits > 0 ? totalLandedCost / totalReceivedUnits : null;

  return NextResponse.json({
    id: manifest.id,
    title: manifest.title,
    supplier: manifest.supplier,
    totalLandedCost,
    createdAt: manifest.createdAt,
    lines,
    unmatchedReceived,
    unmatchedDamaged,
    summary: {
      totalExpectedUnits,
      totalReceivedUnits,
      totalDamagedUnits,
      totalAccountedUnits: totalReceivedUnits + totalDamagedUnits,
      totalMissingUnits: totalExpectedUnits - (totalReceivedUnits + totalDamagedUnits),
      totalManifestExtendedRetail,
      blendedCogsPerUnit,
    },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const data: Record<string, unknown> = {};
  if ("title" in body) data.title = String(body.title).trim();
  if ("totalLandedCost" in body) {
    data.totalLandedCost = body.totalLandedCost === null || body.totalLandedCost === ""
      ? null
      : Number(body.totalLandedCost);
  }

  const manifest = await prisma.manifest.update({ where: { id }, data });
  return NextResponse.json(manifest);
}
