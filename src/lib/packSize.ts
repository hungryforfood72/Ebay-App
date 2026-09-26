// Pack sizes: reading them out of eBay listing titles, and deciding what
// pack size a product is best sold in. Shared by the sourcing agent (per
// manifest line, in the Analyzer) and the scan page's pack suggestion.

// ---------------------------------------------------------------------------
// Estimated selling costs — real fee schedules run ~13% + a small fixed
// component; this is the honest starting point when there's no real sales
// history for a product to take its own fee rate and label cost from.
// ---------------------------------------------------------------------------
export const FALLBACK_FEE_RATE = 0.1325;
export const FALLBACK_FEE_FIXED = 0.3;
export const FALLBACK_SHIPPING_COST = 5;
// Rough extra label cost for each additional unit in a multi-pack listing
// (heavier box), so a bigger pack isn't treated as free to ship.
export const SHIPPING_PER_EXTRA_UNIT = 0.75;

// A "3-Pack" is a totally normal single listing a real buyer buys directly
// — its price is for 3 units, not 1. Confirmed live: sunscreen priced at
// $29.77 for what turned out to be a 3-pack was treated as a
// $29.77-per-bottle price, tripling the manifest's 35 single-bottle
// physical units into ~$1,042 of phantom revenue instead of the real
// ~$347. Every comp's price is normalized to a per-physical-unit basis by
// dividing out its own detected pack size before it ever reaches the
// blended estimate.
//
// "Lot of N" / "Case of N" are genuinely ambiguous phrasing — confirmed
// live against a real 1,234-comp sample that the overwhelming majority of
// "Lot of 2/3/4" listings for a household product (sunscreen) are just a
// casual seller's wording for a small multi-buy bundle, not a reseller
// wholesale lot, and they were consistently among the CHEAPEST per-unit
// comps. Small lot/case quantities are treated exactly like any other pack
// size; only a large quantity (or an unambiguous wholesale/bulk/pallet
// word, which signals reseller-to-reseller pricing that doesn't reflect
// retail-buyer economics) is excluded outright.
//
// "N ct" / "N count" / "box of N" are deliberately NOT pack sizes: they're
// what's inside one retail package ("Band-Aid 30 ct", "Emergen-C 10 ct",
// "box of 50 gauze pads"). Reading them as packs divided those listings'
// prices by 10-50 (or threw them out as a reseller lot).
const RESELLER_BULK_PATTERN = /\b(wholesale|bulk|pallet)\b/i;
export const LARGE_LOT_THRESHOLD = 10;

export function detectPackSize(title: string): number {
  const patterns = [
    /\bpack\s*of\s*(\d{1,3})\b/i,
    /\b(\d{1,3})\s*-?\s*pack\b/i,
    /\b(\d{1,3})\s*pk\b/i,
    /\bset\s*of\s*(\d{1,3})\b/i,
    /\bbundle\s*of\s*(\d{1,3})\b/i,
    /\blot\s*of\s*(\d{1,3})\b/i,
    /\bcase\s*of\s*(\d{1,3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n >= 2 && n <= 48) return n; // sanity bounds — outside this range is more likely a false match (a model number, a size, etc.)
    }
  }
  return 1;
}

// Excluded outright rather than normalized — a genuine reseller/wholesale
// lot's pricing reflects business-to-business economics, not what an
// individual retail listing of the same physical units would fetch.
export function isResellerLot(title: string, packSize: number): boolean {
  return RESELLER_BULK_PATTERN.test(title) || packSize > LARGE_LOT_THRESHOLD;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// What live eBay listings of a product sell for, per pack size.
export type PackStat = { packSize: number; count: number; medianTotal: number };

export type CompSummary = {
  activeCompCount: number;
  // Per single unit, across every usable comp (each divided by its own
  // pack size) — 0 when there are none.
  medianPerUnit: number;
  packSizes: number[];
  packStats: PackStat[];
};

export function summarizeComps(comps: { title: string; totalPrice: number }[]): CompSummary {
  const perUnit: number[] = [];
  const packSizes: number[] = [];
  const totalsByPack = new Map<number, number[]>();
  for (const c of comps) {
    const packSize = detectPackSize(c.title);
    if (isResellerLot(c.title, packSize)) continue;
    packSizes.push(packSize);
    perUnit.push(c.totalPrice / packSize);
    totalsByPack.set(packSize, [...(totalsByPack.get(packSize) ?? []), c.totalPrice]);
  }
  perUnit.sort((a, b) => a - b);
  const packStats = [...totalsByPack.entries()]
    .map(([packSize, totals]) => ({
      packSize,
      count: totals.length,
      medianTotal: Math.round(median(totals.sort((a, b) => a - b)) * 100) / 100,
    }))
    .sort((a, b) => a.packSize - b.packSize);
  return {
    activeCompCount: perUnit.length,
    medianPerUnit: perUnit.length > 0 ? median(perUnit) : 0,
    packSizes,
    packStats,
  };
}

// Reads MarketCompSnapshot.packStats (Json) back into shape, dropping
// anything malformed.
export function parsePackStats(json: unknown): PackStat[] {
  if (!Array.isArray(json)) return [];
  return json.filter(
    (s): s is PackStat =>
      typeof s === "object" &&
      s !== null &&
      Number.isInteger((s as PackStat).packSize) &&
      Number.isInteger((s as PackStat).count) &&
      typeof (s as PackStat).medianTotal === "number"
  );
}

// What one physical unit nets when sold in a pack of `packSize` at
// `packPrice` (buyer-paid total), after fees and our shipping label.
export function netPerUnit(packPrice: number, packSize: number): number {
  const shipping = FALLBACK_SHIPPING_COST + SHIPPING_PER_EXTRA_UNIT * (packSize - 1);
  return (packPrice * (1 - FALLBACK_FEE_RATE) - FALLBACK_FEE_FIXED - shipping) / packSize;
}

export type PackRecommendation = {
  packSize: number;
  // "listings": eBay has enough listings at this pack size to price it.
  // "estimate": only singles are listed, but shipping eats most of a
  // single's price — a 2-pack is modeled at MODELED_TWO_PACK_MULTIPLE x the
  // single price instead.
  basis: "listings" | "estimate";
  compCount: number;
  perPackPrice: number;
  netPerUnit: number;
  singleNetPerUnit: number | null;
};

const MIN_COMPS_PER_PACK = 3;
const MAX_RECOMMENDED_PACK = 6;
// A smaller pack within this share of the best per-unit net wins: it
// sells faster and to more buyers, and the difference is within noise.
const NEAR_BEST_SHARE = 0.9;
const MODELED_TWO_PACK_MULTIPLE = 1.8;
// Shipping "eats most of it" when a single nets less than this share of
// its own price.
const SINGLE_THIN_MARGIN_SHARE = 0.35;

// `retailPrice` (one unit, from the manifest) guards against a comp
// search that found a different product: when listings go for far more
// than the item could plausibly fetch, there's no recommendation rather
// than a confident one built on the wrong thing. Confirmed live: a cryptic
// "GMI ALEXA ROS LDIES NO SHW SC" ($5.99 socks) matched 2 listings at ~$19,
// and a $0.90 graduation balloon weight matched $9.52 balloon bouquets.
export function recommendPackSize(stats: PackStat[], retailPrice?: number | null): PackRecommendation | null {
  const candidates = stats
    .filter((s) => s.count >= MIN_COMPS_PER_PACK && s.packSize <= MAX_RECOMMENDED_PACK)
    .map((s) => ({ ...s, net: netPerUnit(s.medianTotal, s.packSize) }));
  if (candidates.length === 0) return null;
  if (retailPrice != null && retailPrice > 0) {
    const cheapestPerUnit = Math.min(...candidates.map((c) => c.medianTotal / c.packSize));
    if (cheapestPerUnit > retailPrice * 2 + FALLBACK_SHIPPING_COST + 1) return null;
  }

  const single = candidates.find((c) => c.packSize === 1) ?? null;
  const best = candidates.reduce((a, b) => (b.net > a.net ? b : a));
  const chosen =
    best.net > 0 ? candidates.find((c) => c.net >= best.net * NEAR_BEST_SHARE) ?? best : best;

  if (chosen.packSize === 1 && candidates.length === 1 && single) {
    const modeledPrice = single.medianTotal * MODELED_TWO_PACK_MULTIPLE;
    const modeledNet = netPerUnit(modeledPrice, 2);
    const thin = single.net < single.medianTotal * SINGLE_THIN_MARGIN_SHARE;
    if (thin && modeledNet - single.net > Math.max(0.5, Math.abs(single.net) * 0.15)) {
      return {
        packSize: 2,
        basis: "estimate",
        compCount: single.count,
        perPackPrice: Math.round(modeledPrice * 100) / 100,
        netPerUnit: modeledNet,
        singleNetPerUnit: single.net,
      };
    }
  }

  return {
    packSize: chosen.packSize,
    basis: "listings",
    compCount: chosen.count,
    perPackPrice: chosen.medianTotal,
    netPerUnit: chosen.net,
    singleNetPerUnit: single?.net ?? null,
  };
}

// How to list `units` of something best sold in packs of `packSize`: as
// many full packs as possible, with a small leftover folded into one bigger
// pack (7 as 2-packs -> 2 x 2-pack + 1 x 3-pack) and a larger leftover
// listed as its own smaller pack (8 as 3-packs -> 2 x 3-pack + 1 x 2-pack).
export function splitIntoPacks(units: number, packSize: number): { packSize: number; listings: number }[] {
  if (units <= 0) return [];
  if (packSize <= 1) return [{ packSize: 1, listings: units }];
  if (units < packSize) return [{ packSize: units, listings: 1 }];
  const full = Math.floor(units / packSize);
  const leftover = units % packSize;
  if (leftover === 0) return [{ packSize, listings: full }];
  if (leftover <= packSize / 2) {
    return full > 1
      ? [
          { packSize, listings: full - 1 },
          { packSize: packSize + leftover, listings: 1 },
        ]
      : [{ packSize: packSize + leftover, listings: 1 }];
  }
  return [
    { packSize, listings: full },
    { packSize: leftover, listings: 1 },
  ];
}
