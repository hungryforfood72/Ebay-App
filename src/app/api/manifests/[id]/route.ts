import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { getTargetMarginPct, MIN_BID_FLOOR } from "@/lib/sourcingAgent";
import { getRequestUser, ownerOnly } from "@/lib/auth";
import type { Prisma } from "@/generated/prisma/client";
import { parseBundleComponentUnits, soldUnitsFor, unitsFor } from "@/lib/itemUnits";

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
  // Cristian's instruction: employees don't see COGS, profit, revenue, or
  // sourcing/bid decisions — receiving and listing counts only. Same
  // strip-before-send pattern as /api/dashboard, applied at the bottom of
  // this handler rather than skipping the underlying queries (the cost of
  // computing it is the same either way, and this route is one big shared
  // shape for both roles).
  const isOwner = getRequestUser(request)?.role === "owner";

  const manifest = await prisma.manifest.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      damaged: true,
      duds: true,
      walkupSales: true,
      items: {
        select: {
          upc: true,
          quantity: true,
          isMultipack: true,
          packSize: true,
          isBundle: true,
          bundleComponents: true,
          soldQuantity: true,
          soldRevenueTotal: true,
          soldFeesTotal: true,
          soldShippingTotal: true,
          // Net refund cost per sale = amount back to the buyer minus the
          // fees eBay credited back — same as the dashboard's profit.
          sales: { select: { refunds: { select: { amount: true, feeCredit: true } } } },
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
  // Only needed to let the bid calculator flag whether a hypothetical price
  // clears Cristian's configured margin — skip the lookup when there's no
  // evaluation to attach it to.
  const targetMarginPct = latestEvaluation ? await getTargetMarginPct() : null;

  const receivedByUpc = new Map<string, number>();
  const unmatchedReceived: { upc: string | null; units: number }[] = [];
  for (const item of manifest.items) {
    if (item.isBundle) {
      // item.quantity here is "how many complete bundles", not multipack —
      // each component's own quantity is already "per bundle" (see
      // Item.bundleComponents' own comment in schema.prisma).
      for (const c of parseBundleComponentUnits(item.bundleComponents)) {
        const units = c.unitsPerBundle * item.quantity;
        receivedByUpc.set(c.upc, (receivedByUpc.get(c.upc) ?? 0) + units);
      }
      continue;
    }
    if (!item.upc) continue;
    const units = unitsFor(item);
    receivedByUpc.set(item.upc, (receivedByUpc.get(item.upc) ?? 0) + units);
  }
  // A walk-up sale skipped the normal scan-in step, but the unit was still
  // physically received in the same instant it was sold — counts here too,
  // or the line would wrongly show it as still missing.
  for (const w of manifest.walkupSales) {
    receivedByUpc.set(w.upc, (receivedByUpc.get(w.upc) ?? 0) + w.quantity);
  }

  const damagedByUpc = new Map<string, number>();
  for (const d of manifest.damaged) {
    damagedByUpc.set(d.upc, (damagedByUpc.get(d.upc) ?? 0) + d.quantity);
  }

  const dudByUpc = new Map<string, number>();
  for (const d of manifest.duds) {
    dudByUpc.set(d.upc, (dudByUpc.get(d.upc) ?? 0) + d.quantity);
  }

  // Sold units/revenue/fees/shipping/refunds, by UPC — summed regardless of
  // Item.status, since a partially-sold multi-unit listing stays "listed"
  // (not "sold") while still having real sold units and revenue to account
  // for. Shipping and refunds come off profit just like fees do; without
  // them a line's "profit" was really just revenue minus fees and COGS.
  const soldByUpc = new Map<string, number>();
  const soldRevenueByUpc = new Map<string, number>();
  const soldFeesByUpc = new Map<string, number>();
  const soldShippingByUpc = new Map<string, number>();
  const soldRefundsByUpc = new Map<string, number>();
  const addTo = (map: Map<string, number>, upc: string, amount: number) => map.set(upc, (map.get(upc) ?? 0) + amount);
  for (const item of manifest.items) {
    if (item.soldQuantity === 0) continue;
    const shippingTotal = Number(item.soldShippingTotal);
    const refundsNet = item.sales
      .flatMap((s) => s.refunds)
      .reduce((sum, r) => sum + Number(r.amount) - Number(r.feeCredit), 0);
    if (item.isBundle) {
      // A bundle sale's revenue/fees are for the whole bundle, with no
      // per-UPC price breakdown to draw on — split evenly per physical
      // unit across the bundle's components (documented approximation,
      // not a real per-item price). Unit counts themselves are exact.
      const components = parseBundleComponentUnits(item.bundleComponents);
      const totalUnitsPerBundle = components.reduce((sum, c) => sum + c.unitsPerBundle, 0);
      if (totalUnitsPerBundle === 0) continue;
      for (const c of components) {
        const share = c.unitsPerBundle / totalUnitsPerBundle;
        soldByUpc.set(c.upc, (soldByUpc.get(c.upc) ?? 0) + c.unitsPerBundle * item.soldQuantity);
        soldRevenueByUpc.set(c.upc, (soldRevenueByUpc.get(c.upc) ?? 0) + Number(item.soldRevenueTotal) * share);
        soldFeesByUpc.set(c.upc, (soldFeesByUpc.get(c.upc) ?? 0) + Number(item.soldFeesTotal) * share);
        addTo(soldShippingByUpc, c.upc, shippingTotal * share);
        addTo(soldRefundsByUpc, c.upc, refundsNet * share);
      }
      continue;
    }
    if (!item.upc) continue;
    soldByUpc.set(item.upc, (soldByUpc.get(item.upc) ?? 0) + soldUnitsFor(item));
    soldRevenueByUpc.set(item.upc, (soldRevenueByUpc.get(item.upc) ?? 0) + Number(item.soldRevenueTotal));
    soldFeesByUpc.set(item.upc, (soldFeesByUpc.get(item.upc) ?? 0) + Number(item.soldFeesTotal));
    addTo(soldShippingByUpc, item.upc, shippingTotal);
    addTo(soldRefundsByUpc, item.upc, refundsNet);
  }
  // Walk-up sales are just as real as an eBay sale for profit purposes —
  // no fees (cash, in person), no shipping, so only revenue is added.
  for (const w of manifest.walkupSales) {
    soldByUpc.set(w.upc, (soldByUpc.get(w.upc) ?? 0) + w.quantity);
    soldRevenueByUpc.set(w.upc, (soldRevenueByUpc.get(w.upc) ?? 0) + w.quantity * Number(w.pricePerUnit));
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
  const dudAllocation = new Array(manifest.lines.length).fill(0);
  const soldAllocation = new Array(manifest.lines.length).fill(0);
  for (const [upc, indexes] of lineIndexesByUpc) {
    const expectedQuantities = indexes.map((i) => manifest.lines[i].expectedQuantity);
    const received = allocateSequentially(expectedQuantities, receivedByUpc.get(upc) ?? 0, expectedQuantities.map(() => 0));
    const damaged = allocateSequentially(expectedQuantities, damagedByUpc.get(upc) ?? 0, received);
    // Duds are a third claimant on the same expected-quantity capacity,
    // run after received+damaged so all three pools split it without
    // double-counting — physically arrived in good shape, just never
    // going to be listed (see ManifestDudEntry).
    const dud = allocateSequentially(
      expectedQuantities,
      dudByUpc.get(upc) ?? 0,
      received.map((r, i) => r + damaged[i])
    );
    // Sold is a subset of received (you can only sell what actually
    // arrived), not a second claimant on the line's expected capacity like
    // damaged is — so its ceiling per line is that line's received count,
    // not expectedQuantity minus something.
    const sold = allocateSequentially(received, soldByUpc.get(upc) ?? 0, received.map(() => 0));
    indexes.forEach((lineIdx, j) => {
      receivedAllocation[lineIdx] = received[j];
      damagedAllocation[lineIdx] = damaged[j];
      dudAllocation[lineIdx] = dud[j];
      soldAllocation[lineIdx] = sold[j];
    });
  }

  const lines = manifest.lines.map((line, index) => {
    const receivedUnits = receivedAllocation[index];
    const damagedUnits = damagedAllocation[index];
    const dudUnits = dudAllocation[index];
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
    const soldShipping = soldShare * (line.upc ? (soldShippingByUpc.get(line.upc) ?? 0) : 0);
    const soldRefunds = soldShare * (line.upc ? (soldRefundsByUpc.get(line.upc) ?? 0) : 0);
    const soldCogs = weightedCogsPerUnit != null ? soldUnits * weightedCogsPerUnit : null;
    const profit =
      soldUnits > 0 && soldCogs != null ? soldRevenue - soldFees - soldShipping - soldRefunds - soldCogs : null;

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
      dudUnits,
      accountedUnits: receivedUnits + damagedUnits + dudUnits,
      missingUnits: line.expectedQuantity - (receivedUnits + damagedUnits + dudUnits),
      weightedCogsPerUnit,
      soldUnits,
      soldRevenue,
      soldFees,
      soldShipping,
      soldRefunds,
      soldCogs,
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
  const unmatchedDud: { upc: string | null; units: number }[] = [];
  for (const [upc, units] of dudByUpc) {
    if (!matchedUpcs.has(upc)) unmatchedDud.push({ upc, units });
  }
  const unmatchedSold: {
    upc: string | null;
    units: number;
    revenue: number;
    fees: number;
    shipping: number;
    refunds: number;
  }[] = [];
  for (const [upc, units] of soldByUpc) {
    if (!matchedUpcs.has(upc)) {
      unmatchedSold.push({
        upc,
        units,
        revenue: soldRevenueByUpc.get(upc) ?? 0,
        fees: soldFeesByUpc.get(upc) ?? 0,
        shipping: soldShippingByUpc.get(upc) ?? 0,
        refunds: soldRefundsByUpc.get(upc) ?? 0,
      });
    }
  }

  const totalExpectedUnits = lines.reduce((sum, l) => sum + l.expectedQuantity, 0);
  const totalReceivedUnits = lines.reduce((sum, l) => sum + l.receivedUnits, 0) +
    unmatchedReceived.reduce((sum, u) => sum + u.units, 0);
  const totalDamagedUnits = lines.reduce((sum, l) => sum + l.damagedUnits, 0) +
    unmatchedDamaged.reduce((sum, u) => sum + u.units, 0);
  const totalDudUnits = lines.reduce((sum, l) => sum + l.dudUnits, 0) +
    unmatchedDud.reduce((sum, u) => sum + u.units, 0);
  const totalSoldUnits = lines.reduce((sum, l) => sum + l.soldUnits, 0) +
    unmatchedSold.reduce((sum, u) => sum + u.units, 0);
  const totalSoldRevenue = lines.reduce((sum, l) => sum + l.soldRevenue, 0) +
    unmatchedSold.reduce((sum, u) => sum + u.revenue, 0);
  const totalSoldFees = lines.reduce((sum, l) => sum + l.soldFees, 0) +
    unmatchedSold.reduce((sum, u) => sum + u.fees, 0);
  const totalSoldShipping = lines.reduce((sum, l) => sum + l.soldShipping, 0) +
    unmatchedSold.reduce((sum, u) => sum + u.shipping, 0);
  const totalSoldRefunds = lines.reduce((sum, l) => sum + l.soldRefunds, 0) +
    unmatchedSold.reduce((sum, u) => sum + u.refunds, 0);
  const totalSoldCogs = lines.reduce((sum, l) => sum + (l.soldCogs ?? 0), 0);
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
    purchased: manifest.purchased,
    ...(isOwner
      ? {
          bidStatus: manifest.bidStatus,
          bidAmount: manifest.bidAmount != null ? Number(manifest.bidAmount) : null,
          bidPlacedAt: manifest.bidPlacedAt,
          bidClosedAt: manifest.bidClosedAt,
        }
      : {}),
    ...(isOwner ? { totalLandedCost } : {}),
    createdAt: manifest.createdAt,
    lines: lines.map((l) =>
      isOwner
        ? l
        : {
            id: l.id,
            supplierSku: l.supplierSku,
            upc: l.upc,
            description: l.description,
            expectedQuantity: l.expectedQuantity,
            condition: l.condition,
            category: l.category,
            subcategory: l.subcategory,
            receivedUnits: l.receivedUnits,
            damagedUnits: l.damagedUnits,
            dudUnits: l.dudUnits,
            accountedUnits: l.accountedUnits,
            missingUnits: l.missingUnits,
            soldUnits: l.soldUnits,
          }
    ),
    unmatchedReceived,
    unmatchedDamaged,
    unmatchedDud,
    unmatchedSold: unmatchedSold.map((u) => (isOwner ? u : { upc: u.upc, units: u.units })),
    // Sourcing evaluation is entirely a pre-purchase bid decision (buy/don't
    // buy, max bid, reasoning) — Cristian's explicit "bid decisions" callout
    // for what employees shouldn't see. Omitted outright rather than
    // stripped field-by-field since none of it is operationally relevant to
    // receiving/listing work.
    sourcingEvaluation: isOwner && latestEvaluation && {
      id: latestEvaluation.id,
      status: latestEvaluation.status,
      recommendation: latestEvaluation.recommendation,
      maxBid: latestEvaluation.maxBid != null ? Number(latestEvaluation.maxBid) : null,
      expectedNetContribution:
        latestEvaluation.expectedNetContribution != null ? Number(latestEvaluation.expectedNetContribution) : null,
      targetMarginPct,
      minBidFloor: MIN_BID_FLOOR,
      dudShare: latestEvaluation.dudShare,
      concentrationRisk: latestEvaluation.concentrationRisk,
      reasoning: latestEvaluation.reasoning,
      error: latestEvaluation.error,
      processedSteps: latestEvaluation.processedSteps,
      totalSteps: latestEvaluation.totalSteps,
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
        typicalPackSize: e.typicalPackSize,
        dataConfidence: e.dataConfidence,
        flaggedDud: e.flaggedDud,
        slowMover: e.slowMover,
        monthsToSellThrough: e.monthsToSellThrough,
      })),
    },
    summary: {
      totalExpectedUnits,
      totalReceivedUnits,
      totalDamagedUnits,
      totalDudUnits,
      totalAccountedUnits: totalReceivedUnits + totalDamagedUnits + totalDudUnits,
      totalMissingUnits: totalExpectedUnits - (totalReceivedUnits + totalDamagedUnits + totalDudUnits),
      totalSoldUnits,
      totalListedUnsoldItems,
      ...(isOwner
        ? {
            totalManifestExtendedRetail,
            blendedCogsPerUnit,
            totalSoldRevenue,
            totalSoldFees,
            totalSoldShipping,
            totalSoldRefunds,
            totalSoldCogs,
            totalProfit,
          }
        : {}),
    },
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  // Landed cost, purchasing and bids are the owner's call. Renaming is the
  // only change an employee can make here.
  if (["totalLandedCost", "purchased", "bidStatus", "bidAmount"].some((k) => k in body)) {
    const denied = ownerOnly(request);
    if (denied) return denied;
  }

  const data: Prisma.ManifestUpdateInput = {};
  if ("title" in body) data.title = String(body.title).trim();
  if ("totalLandedCost" in body) {
    data.totalLandedCost = body.totalLandedCost === null || body.totalLandedCost === ""
      ? null
      : Number(body.totalLandedCost);
  }
  // "Mark as purchased" — a candidate uploaded via the Analyzer graduates
  // into the real Manifests list. Never goes the other direction from this
  // route (no un-marking), matching the Analyzer being a one-way decision
  // point, not a toggle.
  if ("purchased" in body) data.purchased = Boolean(body.purchased);

  // Bid tracking (Analyzer). { bidStatus: "active", bidAmount } places or
  // updates a bid; "lost" closes it; null clears it back to "under
  // consideration". Marking a candidate with a bid purchased records it as
  // won — the bid amount stays, as the winning bid.
  const now = new Date();
  if ("bidStatus" in body) {
    const status = body.bidStatus;
    if (status === "active") {
      const amount = Number(body.bidAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: "Enter the amount you bid." }, { status: 400 });
      }
      data.bidStatus = "active";
      data.bidAmount = Math.round(amount * 100) / 100;
      data.bidPlacedAt = now;
      data.bidClosedAt = null;
    } else if (status === "lost") {
      data.bidStatus = "lost";
      data.bidClosedAt = now;
    } else if (status === null) {
      data.bidStatus = null;
      data.bidAmount = null;
      data.bidPlacedAt = null;
      data.bidClosedAt = null;
    } else {
      return NextResponse.json({ error: "Unknown bid status." }, { status: 400 });
    }
  }
  if (body.purchased === true) {
    const current = await prisma.manifest.findUnique({ where: { id }, select: { bidAmount: true } });
    if (current?.bidAmount != null) {
      data.bidStatus = "won";
      data.bidClosedAt = now;
    }
  }

  const manifest = await prisma.manifest.update({ where: { id }, data });
  // The full record carries landed cost and the bid — an employee's rename
  // gets back only what they changed.
  if (getRequestUser(request)?.role !== "owner") {
    return NextResponse.json({ id: manifest.id, title: manifest.title });
  }
  return NextResponse.json(manifest);
}
