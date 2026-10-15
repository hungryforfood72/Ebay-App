import { labelForWeight } from "./shippingZone";
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
    // "2-pk." is how Liquidation.com writes it; missed until 2026-10-15,
    // when a Neutrogena twin pack was read as one tube and the scan card
    // said to bundle 3 of them.
    /\b(\d{1,3})\s*-?\s*pk\b/i,
    /\bset\s*of\s*(\d{1,3})\b/i,
    /\bbundle\s*of\s*(\d{1,3})\b/i,
    /\blot\s*of\s*(\d{1,3})\b/i,
    /\bcase\s*of\s*(\d{1,3})\b/i,
    // "LOT(2)", "Lot (3)"
    /\blot\s*\(\s*(\d{1,3})\s*\)/i,
    // "3X Banana Boat ...", "2 x Banana Boat ..." — only at the very start,
    // where it can't be a dimension ("4x4 gauze") or a size ("2X shirt").
    /^\s*(\d{1,2})\s*x\s+(?=[a-z])/i,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n >= 2 && n <= 48) return n; // sanity bounds — outside this range is more likely a false match (a model number, a size, etc.)
    }
  }
  if (/\btwin\s*-?\s*pack\b/i.test(title)) return 2;
  if (/\btriple\s*-?\s*pack\b/i.test(title)) return 3;
  // "3 Cans", "2 Bottles". Capped low on purpose: "12 cans" or "24
  // bottles" is usually one retail case (soda, water), the same trap as
  // "30 ct" above. Found live 2026-09-27: "LOT(2)", "3 Cans" and "3X ..."
  // sunscreen listings were all read as singles, pushing the single price
  // up and making singles look like the better way to sell it.
  const containers = title.match(/\b(\d{1,2})\s*(?:cans|bottles|tubes|jars|canisters)\b/i);
  if (containers) {
    const n = parseInt(containers[1], 10);
    if (n >= 2 && n <= 6) return n;
  }
  return 1;
}

// detectPackSize for a comp of a listing that is itself `listingPackSize`
// units. When we're selling a lot of 28 beef sticks, "Archer Beef Sticks
// 24 Count" is a 24-pack of the same stick, not one retail box: a count
// close to our own pack size (half to double) is read as the pack size.
// Found live 2026-10-15: 20/22/24-count comps at $18-28 were read as single
// sticks and scaled to "$780 for 28".
//
// `countPerPackage` (Item.countPerPackage, read off our own photo by the AI
// draft) settles it when known: a box of 30 bandages makes "30 ct" one box
// and "60 ct" two; an individually wrapped stick (1) makes "24 count" 24.
export function detectPackSizeNear(title: string, listingPackSize: number, countPerPackage?: number | null): number {
  const size = detectPackSize(title);
  if (size > 1) return size;
  const count = title.match(/\b(\d{1,3})\s*-?\s*(?:count|ct|pcs|pieces|sticks|bars|packets|pouches)\b/i);
  if (!count) return size;
  const n = parseInt(count[1], 10);
  if (countPerPackage != null && countPerPackage >= 1) {
    if (countPerPackage === 1) return n >= 2 && n <= 100 ? n : size;
    return n % countPerPackage === 0 && n / countPerPackage <= 48 ? n / countPerPackage : size;
  }
  if (listingPackSize < 2) return size;
  return n >= listingPackSize / 2 && n <= listingPackSize * 2 ? n : size;
}

// Excluded outright rather than normalized — a genuine reseller/wholesale
// lot's pricing reflects business-to-business economics, not what an
// individual retail listing of the same physical units would fetch. Pass
// the size of what we're listing: a 28-stick lot's comps are other 20-30
// stick lots, not reseller lots (before 2026-10-15 every pack over 10 was
// thrown out, so a big lot could never match a comp at all).
export function isResellerLot(title: string, packSize: number, listingPackSize = 1): boolean {
  return RESELLER_BULK_PATTERN.test(title) || packSize > Math.max(LARGE_LOT_THRESHOLD, listingPackSize * 2);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// What live eBay listings of a product sell for, per pack size.
export type PackStat = {
  packSize: number;
  count: number;
  medianTotal: number;
  // The cheapest listing at this pack size — what a bargain-hunting buyer
  // actually compares against (see src/lib/packAdvisor.ts). Absent on
  // snapshots from before 2026-09-27.
  lowestTotal?: number;
  cheapestTitle?: string;
};

export type CompSummary = {
  activeCompCount: number;
  // Per single unit, across every usable comp (each divided by its own
  // pack size) — 0 when there are none.
  medianPerUnit: number;
  packSizes: number[];
  packStats: PackStat[];
};

// `listingPackSize` / `countPerPackage`: the size of what's being priced and
// pieces per unit, when known (see detectPackSizeNear and isResellerLot).
export function summarizeComps(
  comps: { title: string; totalPrice: number }[],
  listingPackSize = 1,
  countPerPackage: number | null = null
): CompSummary {
  const perUnit: number[] = [];
  const packSizes: number[] = [];
  const totalsByPack = new Map<number, number[]>();
  const cheapestByPack = new Map<number, { title: string; totalPrice: number }>();
  for (const c of comps) {
    const packSize = detectPackSizeNear(c.title, listingPackSize, countPerPackage);
    if (isResellerLot(c.title, packSize, listingPackSize)) continue;
    packSizes.push(packSize);
    perUnit.push(c.totalPrice / packSize);
    totalsByPack.set(packSize, [...(totalsByPack.get(packSize) ?? []), c.totalPrice]);
    const cheapest = cheapestByPack.get(packSize);
    if (!cheapest || c.totalPrice < cheapest.totalPrice) cheapestByPack.set(packSize, c);
  }
  perUnit.sort((a, b) => a - b);
  const packStats = [...totalsByPack.entries()]
    .map(([packSize, totals]) => ({
      packSize,
      count: totals.length,
      medianTotal: Math.round(median(totals.sort((a, b) => a - b)) * 100) / 100,
      lowestTotal: Math.round(cheapestByPack.get(packSize)!.totalPrice * 100) / 100,
      cheapestTitle: cheapestByPack.get(packSize)!.title.slice(0, 120),
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
      typeof (s as PackStat).medianTotal === "number" &&
      ((s as PackStat).lowestTotal === undefined || typeof (s as PackStat).lowestTotal === "number") &&
      ((s as PackStat).cheapestTitle === undefined || typeof (s as PackStat).cheapestTitle === "string")
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
export const MAX_RECOMMENDED_PACK = 6;
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

// Every sale has to clear this much profit no matter how little the items
// cost — Cristian (2026-09-28): 35% on cost alone is a low bar when a
// liquidation item cost $0.84 (that's $0.29), not worth listing, packing
// and shipping for. Also the whole bar when the load has no landed cost.
export const MIN_PROFIT_PER_SALE = 1.5;

export type ListingWorth = {
  worthIt: boolean;
  // Realistic buyer-paid price for the whole listing, its label, what the
  // items in it cost, and the profit after all of that.
  price: number;
  label: number;
  itemCost: number | null;
  profit: number;
  // profit / itemCost, as a percent — null without an item cost.
  returnPct: number | null;
  // What it had to clear: the target return on cost or MIN_PROFIT_PER_SALE,
  // whichever is more.
  requiredProfit: number;
};

// The mailer or box itself, on top of the items in it.
export const PACKAGING_OZ = 2;
// A lot bigger than any pack size eBay lists has no price of its own; it's
// priced off the cheapest per-unit rate, less this much, since buyers expect
// a bulk lot to come cheaper per unit than a small pack.
const LOT_PRICE_FACTOR = 0.8;
// The largest whole-lot listing the scan card suggests; more units than
// this split into even lots.
export const MAX_LOT_SIZE = 25;

// Whether a listing of `packSize` units is worth making — for the leftover
// that can't fill the recommended pack. Cristian's rule (2026-09-28): each
// sale should make his target profit (the Analyzer's target margin, 35%)
// on what he paid for the items. The price is the typical listing at that
// size, or the cheapest per-unit rate across pack sizes scaled to it when
// nobody lists that size, capped at 1.5x store retail: a single of an
// everyday product priced above the store just sits.
export function listingWorth(input: {
  packSize: number;
  stats: PackStat[];
  retailPrice: number | null;
  unitCost: number | null;
  labelCost: number;
  targetReturnPct: number;
  // Shipping weight of one unit. With it, the label follows USPS's weight
  // tiers (anything under 1 lb ships for the same price, so 20 ChapSticks
  // cost what one does); without it, SHIPPING_PER_EXTRA_UNIT per extra unit.
  unitWeightOz?: number | null;
}): ListingWorth | null {
  const usable = input.stats.filter((s) => s.count > 0 && s.medianTotal > 0);
  if (usable.length === 0) return null;
  const exact = usable.find((s) => s.packSize === input.packSize);
  const cheapestPerUnit = Math.min(...usable.map((s) => s.medianTotal / s.packSize));
  const largestListed = Math.max(...usable.map((s) => s.packSize));
  let price = exact
    ? exact.medianTotal
    : cheapestPerUnit * input.packSize * (input.packSize > largestListed ? LOT_PRICE_FACTOR : 1);
  if (input.retailPrice != null && input.retailPrice > 0) {
    price = Math.min(price, input.retailPrice * 1.5 * input.packSize);
  }
  const label =
    input.unitWeightOz != null && input.unitWeightOz > 0
      ? labelForWeight(input.labelCost, (input.unitWeightOz * input.packSize + PACKAGING_OZ) / 16)
      : input.labelCost + SHIPPING_PER_EXTRA_UNIT * (input.packSize - 1);
  const itemCost = input.unitCost != null && input.unitCost > 0 ? input.unitCost * input.packSize : null;
  const profit = price * (1 - FALLBACK_FEE_RATE) - FALLBACK_FEE_FIXED - label - (itemCost ?? 0);
  const returnPct = itemCost != null ? (profit / itemCost) * 100 : null;
  const requiredProfit = Math.max(MIN_PROFIT_PER_SALE, itemCost != null ? (itemCost * input.targetReturnPct) / 100 : 0);
  const worthIt = profit >= requiredProfit;
  return { worthIt, price, label, itemCost, profit, returnPct, requiredProfit };
}

// Whatnot's seller fees (8% commission + 2.9% + $0.30 processing), the
// higher of the two stores', so a set-aside that clears this works on
// both Shopify and Whatnot. Same rates shopifySync.ts estimates Whatnot
// sales with.
const SHOP_CHANNEL_FEE_RATE = 0.109;
const SHOP_CHANNEL_FEE_FIXED = 0.3;

export type ShopChannelWorth = {
  worthIt: boolean;
  // The Shopify price: the eBay-equivalent price less the store discount.
  price: number;
  profit: number;
  requiredProfit: number;
};

// The same set-aside item sold on Shopify/Whatnot instead of eBay: the
// buyer pays the label there, so only the price (with the store's
// discount off) and that channel's fees come out. Same bar as
// listingWorth (target return on cost, or MIN_PROFIT_PER_SALE).
export function shopChannelWorth(ebay: ListingWorth, discountPct: number): ShopChannelWorth {
  const price = ebay.price * (1 - discountPct / 100);
  const profit = price * (1 - SHOP_CHANNEL_FEE_RATE) - SHOP_CHANNEL_FEE_FIXED - (ebay.itemCost ?? 0);
  return { worthIt: profit >= ebay.requiredProfit, price, profit, requiredProfit: ebay.requiredProfit };
}
