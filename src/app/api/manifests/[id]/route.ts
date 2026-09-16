import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Units actually received for an item = the quantity scanned, times pack
// size if it's a multipack — the same "3 of a 2-pack = 6 units" accounting
// Cristian described. Bundles have no single UPC and can't be matched to a
// manifest line, so they're excluded from reconciliation entirely.
function unitsFor(item: { quantity: number; isMultipack: boolean; packSize: number | null }): number {
  return item.quantity * (item.isMultipack && item.packSize ? item.packSize : 1);
}

// Same multipack expansion as unitsFor, but for the eBay-order-derived
// soldQuantity — an eBay listing's availableQuantity/lineItem quantity is
// in terms of "how many of this listing" (pack count), the same scale as
// Item.quantity, not the already-expanded physical-unit scale unitsFor
// produces. Needed to keep the sold pool comparable to the received pool
// below.
function soldUnitsFor(item: { soldQuantity: number; isMultipack: boolean; packSize: number | null }): number {
  return item.soldQuantity * (item.isMultipack && item.packSize ? item.packSize : 1);
}

// Fills each line's expected quantity in order before spilling into the
// next — a UPC can legitimately appear on more than one manifest line (e.g.
// the same item split across pallets/lots), and crediting the full total to
// every matching line would double- or triple-count what was actually
// received. `alreadyClaimed` lets a second pool (damaged, run after
// received) respect capacity the first pool already used on each line.
// Once every line in the group is full, whatever's left piles onto the
// last line as a surplus rather than being dropped.
function allocateSequentially(
  expectedQuantities: number[],
  poolTotal: number,
  alreadyClaimed: number[]
): number[] {
  const allocated = expectedQuantities.map(() => 0);
  let remaining = poolTotal;
  for (let i = 0; i < expectedQuantities.length && remaining > 0; i++) {
    const capacity = Math.max(0, expectedQuantities[i] - alreadyClaimed[i]);
    const take = Math.min(capacity, remaining);
    allocated[i] = take;
    remaining -= take;
  }
  if (remaining > 0 && expectedQuantities.length > 0) {
    allocated[expectedQuantities.length - 1] += remaining;
  }
  return allocated;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const manifest = await prisma.manifest.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      damaged: true,
      items: {
        select: {
          upc: true,
          quantity: true,
          isMultipack: true,
          packSize: true,
          isBundle: true,
          soldQuantity: true,
          soldRevenueTotal: true,
          soldFeesTotal: true,
        },
      },
    },
  });
  if (!manifest) {
    return NextResponse.json({ error: "Manifest not found." }, { status: 404 });
  }

  // Latest sourcing evaluation, if any — re-running keeps prior rows as
  // history, so "latest" is just the most recently started one.
  const latestEvaluation = await prisma.sourcingEvaluation.findFirst({
    where: { manifestId: id },
    orderBy: { startedAt: "desc" },
    include: { lineEstimates: { orderBy: { extendedRetail: "desc" } } },
  });

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

  // Sold units/revenue/fees, by UPC — summed regardless of Item.status,
  // since a partially-sold multi-unit listing stays "listed" (not "sold")
  // while still having real sold units and revenue to account for.
  const soldByUpc = new Map<string, number>();
  const soldRevenueByUpc = new Map<string, number>();
  const soldFeesByUpc = new Map<string, number>();
  for (const item of manifest.items) {
    if (item.isBundle || !item.upc || item.soldQuantity === 0) continue;
    soldByUpc.set(item.upc, (soldByUpc.get(item.upc) ?? 0) + soldUnitsFor(item));
    soldRevenueByUpc.set(item.upc, (soldRevenueByUpc.get(item.upc) ?? 0) + Number(item.soldRevenueTotal));
    soldFeesByUpc.set(item.upc, (soldFeesByUpc.get(item.upc) ?? 0) + Number(item.soldFeesTotal));
  }

  const totalManifestExtendedRetail = manifest.lines.reduce(
    (sum, l) => sum + Number(l.extendedRetail),
    0
  );
  const totalLandedCost = manifest.totalLandedCost != null ? Number(manifest.totalLandedCost) : null;

  // Group lines by UPC (in manifest order) so received/damaged pools can be
  // allocated across duplicates instead of double-counted onto each one.
  const lineIndexesByUpc = new Map<string, number[]>();
  manifest.lines.forEach((line, index) => {
    if (!line.upc) return;
    const list = lineIndexesByUpc.get(line.upc) ?? [];
    list.push(index);
    lineIndexesByUpc.set(line.upc, list);
  });

  const receivedAllocation = new Array(manifest.lines.length).fill(0);
  const damagedAllocation = new Array(manifest.lines.length).fill(0);
  const soldAllocation = new Array(manifest.lines.length).fill(0);
  for (const [upc, indexes] of lineIndexesByUpc) {
    const expectedQuantities = indexes.map((i) => manifest.lines[i].expectedQuantity);
    const received = allocateSequentially(expectedQuantities, receivedByUpc.get(upc) ?? 0, expectedQuantities.map(() => 0));
    const damaged = allocateSequentially(expectedQuantities, damagedByUpc.get(upc) ?? 0, received);
    // Sold is a subset of received (you can only sell what actually
    // arrived), not a second claimant on the line's expected capacity like
    // damaged is — so its ceiling per line is that line's received count,
    // not expectedQuantity minus something.
    const sold = allocateSequentially(received, soldByUpc.get(upc) ?? 0, received.map(() => 0));
    indexes.forEach((lineIdx, j) => {
      receivedAllocation[lineIdx] = received[j];
      damagedAllocation[lineIdx] = damaged[j];
      soldAllocation[lineIdx] = sold[j];
    });
  }

  const lines = manifest.lines.map((line, index) => {
    const receivedUnits = receivedAllocation[index];
    const damagedUnits = damagedAllocation[index];
    const soldUnits = soldAllocation[index];

    // This line's proportional share of the load's total declared value —
    // used to weight the shared landed cost, so a pricier line absorbs more
    // of the freight/fee cost than a cheap one rather than splitting evenly.
    // Divided by units actually received good (not the expected count, and
    // not damaged/expired ones) — if fewer good units came in than
    // expected, the same dollar share spreads over fewer units, correctly
    // raising the cost per unit rather than understating it.
    const valueShare = totalManifestExtendedRetail > 0 ? Number(line.extendedRetail) / totalManifestExtendedRetail : 0;
    const weightedCogsPerUnit =
      totalLandedCost != null && receivedUnits > 0
        ? (valueShare * totalLandedCost) / receivedUnits
        : null;

    // A UPC's real sold revenue/fees are dollar totals per UPC, not
    // per-line — split across lines sharing that UPC proportionally to
    // each line's share of that UPC's sold units, the same weighting
    // philosophy as weightedCogsPerUnit's split of the shared landed cost.
    const upcSoldUnits = line.upc ? (soldByUpc.get(line.upc) ?? 0) : 0;
    const soldShare = upcSoldUnits > 0 ? soldUnits / upcSoldUnits : 0;
    const soldRevenue = soldShare * (line.upc ? (soldRevenueByUpc.get(line.upc) ?? 0) : 0);
    const soldFees = soldShare * (line.upc ? (soldFeesByUpc.get(line.upc) ?? 0) : 0);
    const profit = soldUnits > 0 && weightedCogsPerUnit != null ? soldRevenue - soldFees - soldUnits * weightedCogsPerUnit : null;

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
      soldUnits,
      soldRevenue,
      soldFees,
      profit,
    };
  });

  const matchedUpcs = new Set(lineIndexesByUpc.keys());

  // Received/damaged units whose UPC isn't on the manifest at all — extra or
  // mis-scanned items, worth surfacing rather than silently dropping.
  for (const [upc, units] of receivedByUpc) {
    if (!matchedUpcs.has(upc)) unmatchedReceived.push({ upc, units });
  }
  const unmatchedDamaged: { upc: string | null; units: number }[] = [];
  for (const [upc, units] of damagedByUpc) {
    if (!matchedUpcs.has(upc)) unmatchedDamaged.push({ upc, units });
  }
  const unmatchedSold: { upc: string | null; units: number; revenue: number; fees: number }[] = [];
  for (const [upc, units] of soldByUpc) {
    if (!matchedUpcs.has(upc)) {
      unmatchedSold.push({
        upc,
        units,
        revenue: soldRevenueByUpc.get(upc) ?? 0,
        fees: soldFeesByUpc.get(upc) ?? 0,
      });
    }
  }

  const totalExpectedUnits = lines.reduce((sum, l) => sum + l.expectedQuantity, 0);
  const totalReceivedUnits = lines.reduce((sum, l) => sum + l.receivedUnits, 0) +
    unmatchedReceived.reduce((sum, u) => sum + u.units, 0);
  const totalDamagedUnits = lines.reduce((sum, l) => sum + l.damagedUnits, 0) +
    unmatchedDamaged.reduce((sum, u) => sum + u.units, 0);
  const totalSoldUnits = lines.reduce((sum, l) => sum + l.soldUnits, 0) +
    unmatchedSold.reduce((sum, u) => sum + u.units, 0);
  const totalSoldRevenue = lines.reduce((sum, l) => sum + l.soldRevenue, 0) +
    unmatchedSold.reduce((sum, u) => sum + u.revenue, 0);
  const totalSoldFees = lines.reduce((sum, l) => sum + l.soldFees, 0) +
    unmatchedSold.reduce((sum, u) => sum + u.fees, 0);
  const totalProfit = lines.reduce((sum, l) => sum + (l.profit ?? 0), 0);

  const blendedCogsPerUnit =
    totalLandedCost != null && totalReceivedUnits > 0 ? totalLandedCost / totalReceivedUnits : null;

  // Matches the discount route's own eligibility — a legacy CSV-uploaded
  // item that's since been linked up (ebayListingId, no offerId) is just as
  // discountable as one published through the Inventory API.
  const totalListedUnsoldItems = await prisma.item.count({
    where: {
      manifestId: id,
      status: { in: ["listed", "exported"] },
      OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }],
    },
  });

  return NextResponse.json({
    id: manifest.id,
    title: manifest.title,
    supplier: manifest.supplier,
    totalLandedCost,
    createdAt: manifest.createdAt,
    lines,
    unmatchedReceived,
    unmatchedDamaged,
    unmatchedSold,
    sourcingEvaluation: latestEvaluation && {
      id: latestEvaluation.id,
      status: latestEvaluation.status,
      recommendation: latestEvaluation.recommendation,
      maxBid: latestEvaluation.maxBid != null ? Number(latestEvaluation.maxBid) : null,
      reasoning: latestEvaluation.reasoning,
      error: latestEvaluation.error,
      startedAt: latestEvaluation.startedAt,
      completedAt: latestEvaluation.completedAt,
      lineEstimates: latestEvaluation.lineEstimates.map((e) => ({
        id: e.id,
        upc: e.upc,
        description: e.description,
        extendedRetail: Number(e.extendedRetail),
        estimatedUnitSalePrice: e.estimatedUnitSalePrice != null ? Number(e.estimatedUnitSalePrice) : null,
        estimatedNetPerUnit: e.estimatedNetPerUnit != null ? Number(e.estimatedNetPerUnit) : null,
        effectiveUnits: e.effectiveUnits,
        dataConfidence: e.dataConfidence,
        flaggedDud: e.flaggedDud,
      })),
    },
    summary: {
      totalExpectedUnits,
      totalReceivedUnits,
      totalDamagedUnits,
      totalAccountedUnits: totalReceivedUnits + totalDamagedUnits,
      totalMissingUnits: totalExpectedUnits - (totalReceivedUnits + totalDamagedUnits),
      totalManifestExtendedRetail,
      blendedCogsPerUnit,
      totalSoldUnits,
      totalSoldRevenue,
      totalSoldFees,
      totalProfit,
      totalListedUnsoldItems,
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
