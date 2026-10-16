import { getRequestUser } from "@/lib/auth";
import { unitCostForScan } from "@/lib/cogs";
import { getTargetMarginPct, mostCommonCategory } from "@/lib/sourcingAgent";
import { typicalSingleLabelCost } from "@/lib/shippingCost";
import { EbayApiError, searchActiveListings } from "@/lib/ebay";
import { parseBundleComponentUnits, unitsFor } from "@/lib/itemUnits";
import { advisePackSize, readableProductName, savedPackDecision, unitShippingWeightOz } from "@/lib/packAdvisor";
import {
  MAX_LOT_SIZE,
  MAX_RECOMMENDED_PACK,
  detectPackSize,
  listingWorth,
  netPerUnit,
  parsePackStats,
  shopChannelWorth,
  splitIntoPacks,
  summarizeComps,
  type ListingWorth,
  type PackStat,
} from "@/lib/packSize";
import { prisma } from "@/lib/prisma";
import { getShopifyConfig } from "@/lib/shopify";
import { getShopifyDiscountPct } from "@/lib/shopifySync";
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

  // Which manifest to count against: the one being scanned into, when it
  // lists this UPC. Otherwise (no manifest picked on the scanner, or a
  // different load) the newest bought load that has units of it left, or
  // the newest one listing it at all. Cristian: it knew the manifest said 1
  // but still said "if you have fewer than 3".
  let countManifestId: string | null = null;
  let lines: ManifestLineInfo[] = [];
  let unitsLeft: number | null = null;
  let inferredManifestTitle: string | null = null;
  if (manifestId) {
    lines = await prisma.manifestLine.findMany({ where: { manifestId, upc }, select: LINE_SELECT });
    if (lines.length > 0) {
      countManifestId = manifestId;
      unitsLeft = await unitsLeftOnManifest(manifestId, upc, lines);
    }
  }
  if (!countManifestId) {
    const found = await findManifestForUpc(upc);
    if (found) {
      ({ lines, unitsLeft } = found);
      countManifestId = found.manifestId;
      inferredManifestTitle = found.title;
    }
  }
  const description = lines[0]?.description ?? null;

  // A manifest unit that's itself a multi-pack ("... x 2 pack") gets listed
  // as-is — no suggestion to re-split it.
  const manifestPackSize = description != null ? detectPackSize(description) : 1;
  const alreadyMultipack = manifestPackSize > 1;

  let recommendation = null;
  let reason: string | null = null;
  // The real name looked up for manifest shorthand, when one was needed.
  let productName: string | null = null;
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
    // A cached "no listings" isn't trusted: it may just be a search on
    // manifest shorthand that a real product name would fix.
    let packStats = snapshot && snapshot.activeCompCount > 0 ? parsePackStats(snapshot.packStats) : null;
    if (!packStats) {
      try {
        let comps = await searchActiveListings({ upc, keywords: description ?? upc, excludeListingId: null });
        if (comps.length === 0) {
          productName = await readableProductName(upc, description);
          if (productName) comps = await searchActiveListings({ upc, keywords: productName, excludeListingId: null });
        }
        const summary = summarizeComps(comps);
        packStats = summary.packStats;
        await prisma.marketCompSnapshot.create({
          data: {
            upc,
            activeCompCount: summary.activeCompCount,
            medianPrice: summary.medianPerUnit > 0 ? summary.medianPerUnit : null,
            packStats,
            categoryId: mostCommonCategory(comps),
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
      description: productName ?? description ?? packStats.find((s) => s.cheapestTitle)?.cheapestTitle ?? `UPC ${upc}`,
      retailPrice: lines[0] ? Number(lines[0].retailPrice) : null,
      category: lines[0]?.category ?? null,
      packStats,
      allowNoListings: true,
    });
    recommendation = advice;
    reason = advice?.reason ?? null;
  }

  // Everything the manifest listed is already scanned in, but someone's
  // holding one: plan for that one, and say it looks extra.
  // How many Lizvet says she actually has, typed on the card when it doesn't
  // match the manifest (Cristian, 2026-10-15: 5 Hawaiian Tropic in hand,
  // manifest said 3 left), less what she's saved of it since.
  const hand = await handCountLeft(upc, manifestId);
  const alreadyScannedIn = hand == null && unitsLeft === 0;
  const available = hand?.left ?? (unitsLeft == null ? null : Math.max(unitsLeft, 1));

  // Units that shouldn't be listed at the size they'd have to go in. They
  // come out of the plan and Lizvet sets them aside for Cristian to decide
  // on later (a bundle, eBay Live, Whatnot) — his rules, 2026-09-28:
  // - "slow_single": a lone single of something the call says to sell in
  //   multi-packs. That call means singles of it don't sell well, so it's set
  //   aside no matter what the math says (1 lotion when it says 3-packs).
  // - "low_return": any other leftover that can't fill the recommended pack
  //   (or a single, when singles are the call) and wouldn't make his target
  //   profit on what the items cost (and at least $1.50 a sale), after fees
  //   and a real label cost.
  // Off a manifest there's no count, so it's a heads-up about a single.
  //
  // Full packs get the same profit check too (Cristian, 2026-10-15). The
  // agent works from a $5 label and uncapped asking prices, so it said
  // 3-packs for 20 ChapStick tubes ($1.38 retail) that lose about $3.66 each
  // with his real ~$7 label. When the recommended size fails, a bigger pack
  // (one label over more units) takes over if one clears the bar; if none
  // up to MAX_RECOMMENDED_PACK does, the whole lot is set aside, and the
  // card points to Shopify & Whatnot, where the buyer pays the label.
  type SetAsideWhy = "slow_single" | "low_return";
  let setAside: {
    units: number | null;
    packSize: number;
    why: SetAsideWhy;
    worth: ListingWorth | null;
    everything: boolean;
    shopPlan: { packSize: number; listings: number }[] | null;
  } | null = null;
  let targetReturnPct: number | null = null;
  let plan: { packSize: number; listings: number }[] | null = null;
  if (recommendation) {
    const [labelCost, unitCost, target, unitWeightOz] = await Promise.all([
      typicalSingleLabelCost(),
      countManifestId ? unitCostForScan(countManifestId, upc) : Promise.resolve(null),
      getTargetMarginPct(),
      unitShippingWeightOz(upc, productName ?? description ?? stats.find((s) => s.cheapestTitle)?.cheapestTitle ?? `UPC ${upc}`),
    ]);
    targetReturnPct = target;
    const retailPrice = lines[0] ? Number(lines[0].retailPrice) : null;
    const worthAt = (packSize: number) =>
      listingWorth({ packSize, stats, retailPrice, unitCost, labelCost, targetReturnPct: target, unitWeightOz });

    const called = recommendation.packSize;
    const calledWorth = worthAt(called);
    let notWorthOnEbay = false;
    // What everything on hand makes, split into packs of `size` (one pack
    // off a manifest, where there's no count). Only packs that clear the
    // bar count.
    const totalProfit = (size: number) =>
      (available != null ? splitIntoPacks(available, size) : [{ packSize: size, listings: 1 }]).reduce((sum, g) => {
        const w = worthAt(g.packSize);
        return sum + (w?.worthIt ? w.profit * g.listings : 0);
      }, 0);
    // Only for a multi-pack call. A "singles" call means it sells alone
    // (collectibles, hype items), and a single that can't make the bar was
    // already set aside by the leftover rule below, never bundled.
    if (called > 1 && calledWorth && !calledWorth.worthIt) {
      const bigger = Array.from({ length: Math.max(0, MAX_RECOMMENDED_PACK - called) }, (_, i) => called + 1 + i).find(
        (n) => worthAt(n)?.worthIt
      );
      // Nothing up to 6 works: one lot of everything on hand (even lots
      // past MAX_LOT_SIZE), since small items ship together for about the
      // price of one.
      const lot =
        available != null && available > MAX_RECOMMENDED_PACK
          ? Math.ceil(available / Math.ceil(available / MAX_LOT_SIZE))
          : null;
      // Bigger packs vs one lot: whichever makes more for everything on
      // hand (a lot is also one listing and one label).
      const lotWorks = lot != null && Boolean(worthAt(lot)?.worthIt);
      if (bigger && (!lotWorks || totalProfit(bigger) > totalProfit(lot!))) {
        recommendation = { ...recommendation, packSize: bigger };
        reason = `${reason ? `${reason} ` : ""}Bumped up to ${bigger}-packs: as ${called > 1 ? `${called}-packs` : "singles"} it wouldn't make enough profit after shipping and fees.`;
      } else if (lotWorks) {
        recommendation = { ...recommendation, packSize: lot! };
        reason = `Sell it as a lot of ${lot}. Smaller packs wouldn't make enough profit after shipping and fees, and ${lot} of these ship for about what one does.`;
      } else {
        notWorthOnEbay = true;
      }
    }

    const recommended = recommendation.packSize;
    if (notWorthOnEbay) {
      const shopPlan = available != null ? splitIntoPacks(available, recommended) : null;
      plan = available != null ? [] : null;
      setAside = { units: available, packSize: recommended, why: "low_return", worth: calledWorth, everything: true, shopPlan };
    } else {
      plan = available != null ? splitIntoPacks(available, recommended) : null;
      const verdict = (packSize: number): { why: SetAsideWhy; worth: ListingWorth | null } | null => {
        if (packSize >= recommended && recommended > 1) return null; // a full pack (or bigger), checked above
        const worth = worthAt(packSize);
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
        if (aside) setAside = { units: asideUnits, ...aside, everything: false, shopPlan: null };
      } else if (available == null) {
        const v = verdict(1);
        if (v) setAside = { units: null, packSize: 1, ...v, everything: false, shopPlan: null };
      }
    }
  }

  // The same set-aside on Shopify/Whatnot instead, where the buyer pays the
  // label: Lizvet can send it there rather than to the shelf. Only offered
  // once the store is connected. worthIt null = no eBay comps to price it.
  let shopChannel: { worthIt: boolean | null; price: number | null; profit: number | null } | null = null;
  if (setAside && getShopifyConfig()) {
    if (setAside.worth) {
      const w = shopChannelWorth(setAside.worth, await getShopifyDiscountPct());
      shopChannel = { worthIt: w.worthIt, price: w.price, profit: w.profit };
    } else {
      shopChannel = { worthIt: null, price: null, profit: null };
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
    // How many come in each unit the manifest counts (2 for a twin pack).
    manifestPackSize,
    available,
    // available is the count typed on the card, not the manifest's.
    countedByHand: hand != null,
    // The count she typed (available is what's left of it).
    handCount: hand?.count ?? null,
    // What the manifest says is left, for "the manifest says 3".
    manifestLeft: unitsLeft,
    // Counted against a load other than the one being scanned into (or none
    // was picked) — its title, so the card can say where the count's from.
    manifestTitle: inferredManifestTitle,
    alreadyScannedIn,
    expected: lines.reduce((sum, l) => sum + l.expectedQuantity, 0) || null,
    plan,
    setAside: setAside && {
      units: setAside.units,
      packSize: setAside.packSize,
      why: setAside.why,
      everything: setAside.everything,
      shopPlan: setAside.shopPlan,
      ...(isOwner && setAside.worth
        ? {
            price: setAside.worth.price,
            label: setAside.worth.label,
            itemCost: setAside.worth.itemCost,
            profit: setAside.worth.profit,
            returnPct: setAside.worth.returnPct,
            requiredProfit: setAside.worth.requiredProfit,
            targetReturnPct,
          }
        : {}),
      shopChannel: shopChannel && {
        worthIt: shopChannel.worthIt,
        ...(isOwner ? { price: shopChannel.price, profit: shopChannel.profit } : {}),
      },
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

// POST { upc, manifestId, count } — saves the count Lizvet typed on the
// pack card; count null clears it, back to the manifest's count.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { upc?: string; manifestId?: string | null; count?: number | null } | null;
  const upc = body?.upc?.trim();
  if (!upc) return NextResponse.json({ error: "A UPC is required." }, { status: 400 });
  const manifestId = body?.manifestId || null;
  const count = Number(body?.count);
  if (body?.count != null && (!Number.isInteger(count) || count < 1 || count > 1000)) {
    return NextResponse.json({ error: "Enter a whole number from 1 to 1000." }, { status: 400 });
  }
  await prisma.handCount.deleteMany({ where: { upc, manifestId } });
  if (body?.count != null) await prisma.handCount.create({ data: { upc, manifestId, count } });
  return NextResponse.json({ ok: true });
}

// A typed count older than this is from another day's work, not the
// product in hand now.
const HAND_COUNT_MAX_AGE_DAYS = 3;

// The typed count for this UPC (on this manifest, or off any), less every
// unit of it saved since it was typed: listed, inside a bundle, sold at a
// walk-up, or marked damaged or dud. Used up = cleared, and the card goes
// back to the manifest's own count.
async function handCountLeft(upc: string, manifestId: string | null): Promise<{ count: number; left: number } | null> {
  const hc = await prisma.handCount.findFirst({
    where: { upc, manifestId, createdAt: { gte: new Date(Date.now() - HAND_COUNT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) } },
    orderBy: { createdAt: "desc" },
  });
  if (!hc) return null;
  const since = { gte: hc.createdAt };
  const none = Promise.resolve({ _sum: { quantity: 0 as number | null } });
  const [items, bundles, walkups, damaged, duds] = await Promise.all([
    prisma.item.findMany({ where: { manifestId, upc, isBundle: false, createdAt: since }, select: { quantity: true, isMultipack: true, packSize: true } }),
    prisma.item.findMany({ where: { manifestId, isBundle: true, createdAt: since }, select: { quantity: true, bundleComponents: true } }),
    manifestId ? prisma.manifestWalkupSale.aggregate({ where: { manifestId, upc, createdAt: since }, _sum: { quantity: true } }) : none,
    manifestId ? prisma.manifestDamagedEntry.aggregate({ where: { manifestId, upc, createdAt: since }, _sum: { quantity: true } }) : none,
    manifestId ? prisma.manifestDudEntry.aggregate({ where: { manifestId, upc, createdAt: since }, _sum: { quantity: true } }) : none,
  ]);
  const used =
    items.reduce((sum, i) => sum + unitsFor(i), 0) +
    bundles.reduce(
      (sum, b) =>
        sum +
        parseBundleComponentUnits(b.bundleComponents)
          .filter((c) => c.upc === upc)
          .reduce((s, c) => s + c.unitsPerBundle * b.quantity, 0),
      0
    ) +
    (walkups._sum.quantity ?? 0) +
    (damaged._sum.quantity ?? 0) +
    (duds._sum.quantity ?? 0);
  const left = hc.count - used;
  if (left <= 0) {
    await prisma.handCount.delete({ where: { id: hc.id } }).catch(() => {});
    return null;
  }
  return { count: hc.count, left };
}

const LINE_SELECT = { description: true, expectedQuantity: true, retailPrice: true, category: true } as const;
type ManifestLineInfo = { description: string; expectedQuantity: number; retailPrice: Prisma.Decimal; category: string | null };

async function findManifestForUpc(
  upc: string
): Promise<{ manifestId: string; title: string; lines: ManifestLineInfo[]; unitsLeft: number } | null> {
  const found = await prisma.manifestLine.findMany({
    where: { upc, manifest: { purchased: true } },
    select: { ...LINE_SELECT, manifestId: true, manifest: { select: { title: true, createdAt: true } } },
  });
  const byManifest = new Map<string, { title: string; createdAt: Date; lines: ManifestLineInfo[] }>();
  for (const l of found) {
    const entry = byManifest.get(l.manifestId) ?? { title: l.manifest.title, createdAt: l.manifest.createdAt, lines: [] };
    entry.lines.push(l);
    byManifest.set(l.manifestId, entry);
  }
  const newestFirst = [...byManifest.entries()].sort(([, a], [, b]) => b.createdAt.getTime() - a.createdAt.getTime());
  let fallback: { manifestId: string; title: string; lines: ManifestLineInfo[]; unitsLeft: number } | null = null;
  for (const [id, m] of newestFirst) {
    const unitsLeft = await unitsLeftOnManifest(id, upc, m.lines);
    const candidate = { manifestId: id, title: m.title, lines: m.lines, unitsLeft };
    if (unitsLeft > 0) return candidate;
    fallback ??= candidate;
  }
  return fallback;
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
