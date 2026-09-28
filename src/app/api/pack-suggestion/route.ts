import { getRequestUser } from "@/lib/auth";
import { unitCostForScan } from "@/lib/cogs";
import { getTargetMarginPct } from "@/lib/sourcingAgent";
import { typicalSingleLabelCost } from "@/lib/shippingCost";
import { EbayApiError, searchActiveListings } from "@/lib/ebay";
import { parseBundleComponentUnits, unitsFor } from "@/lib/itemUnits";
import { advisePackSize, savedPackDecision } from "@/lib/packAdvisor";
import {
  detectPackSize,
  listingWorth,
  netPerUnit,
  parsePackStats,
  splitIntoPacks,
  summarizeComps,
  type ListingWorth,
  type PackStat,
} from "@/lib/packSize";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Pack-size pricing barely moves day to day — a week-old check (the
// Analyzer's, usually) is plenty for a suggestion, and reusing it keeps
// scanning from spending eBay Browse API calls.
const PACK_STATS_MAX_AGE_DAYS = 7;

// GET ?upc=&manifestId= — for the scan page: the best pack size to sell a
// product in (see src/lib/packSize.ts), and, when scanning into a manifest,
// how many units of it are still left to list and how to split them. So
// whoever's scanning doesn't have to go look it up on eBay themselves.
// Dollar figures are for the owner only.
export async function GET(request: NextRequest) {
  const isOwner = getRequestUser(request)?.role === "owner";
  const upc = request.nextUrl.searchParams.get("upc")?.trim();
  const manifestId = request.nextUrl.searchParams.get("manifestId");
  if (!upc) return NextResponse.json({ error: "A UPC is required." }, { status: 400 });

  const lines = manifestId
    ? await prisma.manifestLine.findMany({
        where: { manifestId, upc },
        select: { description: true, expectedQuantity: true, retailPrice: true, category: true },
      })
    : [];
  const description = lines[0]?.description ?? null;

  // A manifest unit that's itself a multi-pack ("... x 2 pack") gets listed
  // as-is — no suggestion to re-split it.
  const alreadyMultipack = description != null && detectPackSize(description) > 1;

  let recommendation = null;
  let reason: string | null = null;
  let stats: PackStat[] = [];
  // The Analyzer (or an earlier scan) already decided this UPC: use that
  // with no eBay lookup at all, so the card shows instantly. The owner's
  // dollar figures come from the newest saved snapshot, however old.
  const saved = alreadyMultipack ? null : await savedPackDecision(upc);
  if (saved) {
    recommendation = saved;
    reason = saved.reason;
    const snapshot = await prisma.marketCompSnapshot.findFirst({
      where: { upc, packStats: { not: Prisma.DbNull } },
      orderBy: { capturedAt: "desc" },
    });
    stats = snapshot ? parsePackStats(snapshot.packStats) : [];
  } else if (!alreadyMultipack) {
    const since = new Date(Date.now() - PACK_STATS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    const snapshot = await prisma.marketCompSnapshot.findFirst({
      where: { upc, capturedAt: { gte: since }, packStats: { not: Prisma.DbNull } },
      orderBy: { capturedAt: "desc" },
    });
    let packStats = snapshot ? parsePackStats(snapshot.packStats) : null;
    if (!packStats) {
      try {
        const summary = summarizeComps(
          await searchActiveListings({ upc, keywords: description ?? upc, excludeListingId: null })
        );
        packStats = summary.packStats;
        await prisma.marketCompSnapshot.create({
          data: {
            upc,
            activeCompCount: summary.activeCompCount,
            medianPrice: summary.medianPerUnit > 0 ? summary.medianPerUnit : null,
            packStats,
          },
        });
      } catch (e) {
        if (!(e instanceof EbayApiError)) throw e;
        console.error(`[pack-suggestion] comp search failed for UPC ${upc}`, e);
        packStats = [];
      }
    }
    stats = packStats;
    // Scanned outside a manifest there's no manifest description; the
    // cheapest listing's title tells the agent what the product is.
    const advice = await advisePackSize({
      upc,
      description: description ?? packStats.find((s) => s.cheapestTitle)?.cheapestTitle ?? `UPC ${upc}`,
      retailPrice: lines[0] ? Number(lines[0].retailPrice) : null,
      category: lines[0]?.category ?? null,
      packStats,
    });
    recommendation = advice;
    reason = advice?.reason ?? null;
  }

  const available = manifestId && lines.length > 0 ? await unitsLeftOnManifest(manifestId, upc, lines) : null;
  let plan = recommendation && available != null && available > 0 ? splitIntoPacks(available, recommendation.packSize) : null;

  // Units that shouldn't be listed at the size they'd have to go in. They
  // come out of the plan and Lizvet sets them aside for Cristian to decide
  // on later (a bundle, eBay Live, Whatnot) — his rules, 2026-09-28:
  // - "slow_single": a lone single of something the call says to sell in
  //   multi-packs. That call means singles of it don't sell well, so it's set
  //   aside no matter what the math says (1 lotion when it says 3-packs).
  // - "low_return": any other leftover that can't fill the recommended pack
  //   (or a single, when singles are the call) and wouldn't make his target
  //   profit on what the items cost, after fees and a real label cost.
  // Off a manifest there's no count, so it's a heads-up about a single.
  type SetAsideWhy = "slow_single" | "low_return";
  let setAside: { units: number | null; packSize: number; why: SetAsideWhy; worth: ListingWorth | null } | null = null;
  let targetReturnPct: number | null = null;
  if (recommendation) {
    const [labelCost, unitCost, target] = await Promise.all([
      typicalSingleLabelCost(),
      manifestId ? unitCostForScan(manifestId, upc) : Promise.resolve(null),
      getTargetMarginPct(),
    ]);
    targetReturnPct = target;
    const retailPrice = lines[0] ? Number(lines[0].retailPrice) : null;
    const recommended = recommendation.packSize;
    const verdict = (packSize: number): { why: SetAsideWhy; worth: ListingWorth | null } | null => {
      if (packSize >= recommended && recommended > 1) return null; // a full pack (or bigger)
      const worth = listingWorth({ packSize, stats, retailPrice, unitCost, labelCost, targetReturnPct: target });
      if (packSize === 1 && recommended > 1) return { why: "slow_single", worth };
      return worth && !worth.worthIt ? { why: "low_return", worth } : null;
    };
    if (plan) {
      const kept: typeof plan = [];
      let asideUnits = 0;
      let aside: { packSize: number; why: SetAsideWhy; worth: ListingWorth | null } | null = null;
      for (const group of plan) {
        const v = verdict(group.packSize);
        if (v) {
          asideUnits += group.packSize * group.listings;
          aside = { packSize: group.packSize, ...v };
        } else {
          kept.push(group);
        }
      }
      plan = kept;
      if (aside) setAside = { units: asideUnits, ...aside };
    } else if (available == null) {
      const v = verdict(1);
      if (v) setAside = { units: null, packSize: 1, ...v };
    }
  }

  // Dollar figures from the listings at the chosen pack size, when there
  // are any (the agent can pick a size nobody lists yet).
  const chosenStat = recommendation ? stats.find((s) => s.packSize === recommendation.packSize) : undefined;
  const singleStat = stats.find((s) => s.packSize === 1);

  return NextResponse.json({
    upc,
    isOwner,
    alreadyMultipack,
    available,
    plan,
    setAside: setAside && {
      units: setAside.units,
      packSize: setAside.packSize,
      why: setAside.why,
      ...(isOwner && setAside.worth
        ? {
            price: setAside.worth.price,
            label: setAside.worth.label,
            itemCost: setAside.worth.itemCost,
            profit: setAside.worth.profit,
            returnPct: setAside.worth.returnPct,
            targetReturnPct,
          }
        : {}),
    },
    recommendation: recommendation && {
      packSize: recommendation.packSize,
      basis: recommendation.basis,
      reason,
      compCount: chosenStat?.count ?? 0,
      ...(isOwner
        ? {
            perPackPrice: chosenStat?.medianTotal ?? null,
            netPerUnit: chosenStat ? netPerUnit(chosenStat.medianTotal, chosenStat.packSize) : null,
            singleNetPerUnit: singleStat ? netPerUnit(singleStat.medianTotal, 1) : null,
          }
        : {}),
    },
  });
}

// Units of this UPC the manifest said were coming, minus everything
// already accounted for: scanned in (on its own or inside a bundle), sold
// at a walk-up, or marked damaged or dud. Same buckets as the manifest
// page's reconciliation.
async function unitsLeftOnManifest(
  manifestId: string,
  upc: string,
  lines: { expectedQuantity: number }[]
): Promise<number> {
  const [items, bundles, walkups, damaged, duds] = await Promise.all([
    prisma.item.findMany({ where: { manifestId, upc, isBundle: false }, select: { quantity: true, isMultipack: true, packSize: true } }),
    prisma.item.findMany({ where: { manifestId, isBundle: true }, select: { quantity: true, bundleComponents: true } }),
    prisma.manifestWalkupSale.aggregate({ where: { manifestId, upc }, _sum: { quantity: true } }),
    prisma.manifestDamagedEntry.aggregate({ where: { manifestId, upc }, _sum: { quantity: true } }),
    prisma.manifestDudEntry.aggregate({ where: { manifestId, upc }, _sum: { quantity: true } }),
  ]);
  const expected = lines.reduce((sum, l) => sum + l.expectedQuantity, 0);
  const scanned = items.reduce((sum, i) => sum + unitsFor(i), 0);
  const inBundles = bundles.reduce(
    (sum, b) =>
      sum +
      parseBundleComponentUnits(b.bundleComponents)
        .filter((c) => c.upc === upc)
        .reduce((s, c) => s + c.unitsPerBundle * b.quantity, 0),
    0
  );
  const accounted =
    scanned + inBundles + (walkups._sum.quantity ?? 0) + (damaged._sum.quantity ?? 0) + (duds._sum.quantity ?? 0);
  return Math.max(0, expected - accounted);
}
