import { prisma } from "./prisma";
import { anthropic } from "./anthropic";
import { EbayApiError, searchActiveListings } from "./ebay";
import type { ManifestSupplier } from "@/generated/prisma/client";

// ---------------------------------------------------------------------------
// Settings (AppSetting key/value store)
// ---------------------------------------------------------------------------

const TARGET_MARGIN_KEY = "sourcing_target_margin_pct";
const DEFAULT_TARGET_MARGIN_PCT = 35;

export async function getTargetMarginPct(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: TARGET_MARGIN_KEY } });
  const value = row ? Number(row.value) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TARGET_MARGIN_PCT;
}

export async function setTargetMarginPct(pct: number): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: TARGET_MARGIN_KEY },
    create: { key: TARGET_MARGIN_KEY, value: String(pct) },
    update: { value: String(pct) },
  });
}

// ---------------------------------------------------------------------------
// Shared unit-conversion helper — same "physical units = listing quantity ×
// pack size" accounting the manifest reconciliation route and cogs.ts both
// already use, so sold-price/fee/shipping averages line up on the same
// per-physical-unit basis as ManifestLine.retailPrice.
// ---------------------------------------------------------------------------

function soldPhysicalUnits(item: { soldQuantity: number; isMultipack: boolean; packSize: number | null }): number {
  return item.soldQuantity * (item.isMultipack && item.packSize ? item.packSize : 1);
}

// ---------------------------------------------------------------------------
// Estimated eBay fee — real fee schedules run ~13% + a small fixed
// component; refined over time via SourcingKnowledge's global scope rather
// than hardcoded forever, but this is the honest starting point.
// ---------------------------------------------------------------------------
const FALLBACK_FEE_RATE = 0.1325;
const FALLBACK_FEE_FIXED = 0.3;
const FALLBACK_SHIPPING_COST = 5;

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
// comps — exactly the real-world price a human would spot, and exactly
// what got thrown out by blanket-excluding every "lot of"-titled comp.
// Small lot/case quantities are now treated exactly like any other pack
// size instead; only a large quantity (or an unambiguous wholesale/bulk/
// pallet word, which signals reseller-to-reseller pricing that doesn't
// reflect retail-buyer economics) is still excluded outright.
const RESELLER_BULK_PATTERN = /\b(wholesale|bulk|pallet)\b/i;
const LARGE_LOT_THRESHOLD = 10;

function detectPackSize(title: string): number {
  const patterns = [
    /\bpack\s*of\s*(\d{1,3})\b/i,
    /\b(\d{1,3})\s*-?\s*pack\b/i,
    /\b(\d{1,3})\s*pk\b/i,
    /\b(\d{1,3})\s*ct\b/i,
    /\b(\d{1,3})\s*count\b/i,
    /\bset\s*of\s*(\d{1,3})\b/i,
    /\bbundle\s*of\s*(\d{1,3})\b/i,
    /\blot\s*of\s*(\d{1,3})\b/i,
    /\bcase\s*of\s*(\d{1,3})\b/i,
    /\bbox\s*of\s*(\d{1,3})\b/i,
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
// individual retail listing of the same physical units would fetch, so
// dividing its total by its quantity would understate a realistic retail
// per-unit price.
function isResellerLot(title: string, packSize: number): boolean {
  if (RESELLER_BULK_PATTERN.test(title)) return true;
  if (packSize > LARGE_LOT_THRESHOLD) return true;
  return false;
}

// Mode (most frequent value) of a list of pack sizes — used to decide what
// this UPC is realistically LISTED as (one bottle vs. a 3-pack), which
// matters for shipping/fixed-fee costs: those are charged once per
// listing, not once per physical unit, so amortizing them over the wrong
// unit count either over- or under-states them (see estimateLine).
function modePackSize(sizes: number[]): number {
  if (sizes.length === 0) return 1;
  const counts = new Map<number, number>();
  for (const s of sizes) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best = 1;
  let bestCount = 0;
  for (const [size, count] of counts) {
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return best;
}

// When there's no real sales history to trust a market estimate against
// (market_only confidence), a per-unit price more than this many times the
// manifest's own declared retail is more likely a comp-matching error
// (e.g. a pack size detectPackSize missed) than a genuine "sells for way
// above retail" item — liquidation merchandise essentially never does.
// Capped, not discarded, so the line still contributes something rather
// than being silently zeroed.
const MARKET_ONLY_RETAIL_MULTIPLE_CAP = 3;

// Commonsense seasonal fallback, used only until a category has enough real
// sold-data spread across months to compute its own pattern (see
// seasonalNote below). Deliberately coarse — a placeholder to be corrected
// by real data, not a research project.
const SEASONAL_HINTS: { pattern: RegExp; months: number[]; note: string }[] = [
  { pattern: /school|backpack|binder|notebook|crayon|glue stick|lunch ?box/i, months: [6, 7], note: "back-to-school demand typically picks up ahead of August" },
  { pattern: /gift|electronics?|toy|holiday|christmas/i, months: [9, 10, 11], note: "gift/electronics categories typically pick up ahead of the winter holidays" },
  { pattern: /sunscreen|swim|pool|beach|bbq|grill/i, months: [3, 4, 5], note: "outdoor/summer items typically pick up ahead of summer" },
  { pattern: /costume|halloween|candy/i, months: [7, 8, 9], note: "Halloween-adjacent items typically pick up starting late summer" },
  { pattern: /skin ?care|beauty|cosmetic/i, months: [10, 11], note: "beauty/skincare often sees a gift-season bump" },
];

// Recurring-holiday "aftermath filler" — a liquidation load's Halloween/
// Easter/Christmas merch very often shows up *after* that holiday already
// passed (Cristian's own described experience: these loads routinely
// arrive post-holiday, and outside of Halloween candy specifically, this
// stuff is filler he sorts out to toss or donate, not sell). Different
// from SEASONAL_HINTS above (a soft pre-holiday demand nudge) and from the
// one-time-event check below (World Cup, Super Bowl — events that don't
// recur on a predictable yearly calendar) — this is a hard dud override
// for calendar-recurring holiday merch found outside its narrow real
// sell-through window, based directly on how Cristian actually sorts
// these loads rather than a live check, since the calendar dates
// themselves don't need looking up.
// Expressed as deadMonths (the real aftermath window, right after the
// holiday until a reasonable pre-season ramp-up begins) rather than a
// narrow "sellMonths" allowlist — buying stock a couple months *ahead* of
// a holiday is completely normal and should never be flagged, only stock
// still sitting around *after* it already passed. An earlier version of
// this used sellMonths and wrongly flagged pre-season stock too (caught
// live: Christmas ornaments in September — 3+ months of lead time,
// perfectly sellable — came back flagged as a dud).
const POST_HOLIDAY_DUD_RULES: { pattern: RegExp; deadMonths: number[]; exception?: RegExp }[] = [
  // Halloween (Oct 31): dead Nov-Jun, candy still moves afterward (a
  // consumable, not seasonal decor).
  { pattern: /halloween|costume/i, deadMonths: [10, 11, 0, 1, 2, 3, 4, 5], exception: /candy|chocolate/i },
  // Christmas (Dec 25): dead Jan-Jul.
  { pattern: /christmas|advent calendar|ornament|gift ?wrap|santa/i, deadMonths: [0, 1, 2, 3, 4, 5, 6] },
  // Easter (~Mar/Apr, moves year to year — stays wide): dead May-Dec.
  { pattern: /\beaster\b/i, deadMonths: [4, 5, 6, 7, 8, 9, 10, 11] },
  // Valentine's Day (Feb 14): dead Mar-Sep.
  { pattern: /valentine/i, deadMonths: [2, 3, 4, 5, 6, 7, 8] },
  // St. Patrick's Day (Mar 17): dead Apr-Nov.
  { pattern: /st\.? ?patrick/i, deadMonths: [3, 4, 5, 6, 7, 8, 9, 10] },
  // Mother's Day (~early May): dead Jun-Dec.
  { pattern: /mother'?s day/i, deadMonths: [5, 6, 7, 8, 9, 10, 11] },
  // Father's Day (~mid-June): dead Jul-Jan.
  { pattern: /father'?s day/i, deadMonths: [6, 7, 8, 9, 10, 11, 0] },
  // Independence Day (Jul 4): dead Aug-Feb.
  { pattern: /independence day|4th of july|fourth of july/i, deadMonths: [7, 8, 9, 10, 11, 0, 1] },
  // Thanksgiving (late Nov): dead Dec-Jun.
  { pattern: /thanksgiving/i, deadMonths: [11, 0, 1, 2, 3, 4, 5] },
  // New Year's (Jan 1): dead Feb-Aug.
  { pattern: /new ?year'?s (eve|day)/i, deadMonths: [1, 2, 3, 4, 5, 6, 7] },
  // Graduation (~May/Jun): dead Jul-Dec.
  { pattern: /graduation/i, deadMonths: [6, 7, 8, 9, 10, 11] },
];

function isPostHolidayFiller(description: string): boolean {
  const currentMonth = new Date().getMonth(); // 0-indexed
  for (const rule of POST_HOLIDAY_DUD_RULES) {
    if (!rule.pattern.test(description)) continue;
    if (rule.exception && rule.exception.test(description)) return false;
    if (rule.deadMonths.includes(currentMonth)) return true;
  }
  return false;
}

function seasonalHint(category: string | null, description: string): string | null {
  const text = `${category ?? ""} ${description}`;
  const currentMonth = new Date().getMonth(); // 0-indexed
  for (const hint of SEASONAL_HINTS) {
    if (hint.pattern.test(text) && hint.months.includes(currentMonth)) {
      return hint.note;
    }
  }
  return null;
}

// Real seasonal signal, once enough history exists for a category — a
// simple "which of the next couple months has historically sold the most
// units for this category" check, not a full statistical model. Falls back
// to the static hint above when there isn't enough spread yet (spec calls
// for exactly this two-layer approach).
async function seasonalNote(category: string | null, description: string): Promise<string | null> {
  if (!category) return seasonalHint(category, description);
  const upcsInCategory = await prisma.manifestLine.findMany({
    where: { category },
    select: { upc: true },
    distinct: ["upc"],
  });
  const upcs = upcsInCategory.map((l) => l.upc).filter((u): u is string => Boolean(u));
  if (upcs.length === 0) return seasonalHint(category, description);

  const sales = await prisma.ebayItemSale.findMany({
    where: { item: { upc: { in: upcs } } },
    select: { soldAt: true },
  });
  const months = new Set(sales.map((s) => s.soldAt.getMonth()));
  if (sales.length < 10 || months.size < 3) return seasonalHint(category, description);

  const byMonth = new Map<number, number>();
  for (const s of sales) byMonth.set(s.soldAt.getMonth(), (byMonth.get(s.soldAt.getMonth()) ?? 0) + 1);
  const currentMonth = new Date().getMonth();
  const nextMonth = (currentMonth + 1) % 12;
  const avg = sales.length / 12;
  const currentCount = (byMonth.get(currentMonth) ?? 0) + (byMonth.get(nextMonth) ?? 0);
  if (currentCount > avg * 1.5) {
    return `real sales history shows "${category}" selling faster than average this time of year`;
  }
  if (currentCount < avg * 0.5) {
    return `real sales history shows "${category}" selling slower than average this time of year`;
  }
  return null;
}

// A web-search-enabled response splits its answer across several separate
// "text" content blocks whenever it cites a source (a citation ends one
// text block and starts a new one) — grabbing only the first block (as an
// earlier version of this file did) silently returns just the opening
// clause ("Based on the search results, ") instead of the actual answer,
// which usually comes later. Confirmed live: this was why the FIFA
// World-Cup-ended check returned false even though the model's full answer
// correctly said "YES" — string concatenation across every text block on
// the full response, not `.find()`.
function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Trend signal — directional only, never overrides real sales history.
// Uses Anthropic's server-side web search tool (executed entirely within
// one API call, no client-side tool loop needed). Best-effort: a failure
// here just means no trend nudge for that line, not a failed evaluation.
// ---------------------------------------------------------------------------
async function getTrendNudge(description: string): Promise<string | null> {
  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 300,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2, allowed_callers: ["direct"] }],
        messages: [
          {
            role: "user",
            content: `Is "${description}" currently seeing any notable spike or dropoff in search/social interest or demand? Answer in one short sentence, plainly stating up, down, or no notable signal. If you can't find anything meaningful, just say "No notable signal."`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    const text = extractText(response.content).trim();
    if (!text || /no notable signal/i.test(text)) return null;
    return text;
  } catch (e) {
    console.error(`[sourcingAgent] trend nudge failed for "${description}"`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Occasion-tied merchandise not covered by the cheap deterministic checks
// above — either a one-time event (World Cup, Super Bowl, Olympics — never
// recurs the same way) or a named holiday/observance not in
// POST_HOLIDAY_DUD_RULES (that list only covers the handful of most common
// gift-holidays; liquidation manifests turn up plenty of others —
// Hanukkah, Diwali, Mardi Gras, Cinco de Mayo, Lunar New Year, and more
// neither of us thought to hardcode). Rather than keep expanding a
// hardcoded list forever, anything matching this broader pattern gets a
// live check instead. Real gap found live: a "FIFA World Cup '26" line was
// scored using live market comps with no awareness the tournament itself
// had already concluded — dead licensed merch still shows plenty of
// "active" comps (other liquidators dumping the same dead stock), which
// looks like market activity but isn't real demand. Gated by a cheap regex
// pre-filter (free) before ever spending a web search call, and capped per
// evaluation so a manifest dominated by this kind of merch (exactly the
// FIFA case) can't blow the budget.
// ---------------------------------------------------------------------------
const OCCASION_MERCH_PATTERN =
  /\b(world cup|super bowl|olympics?|world series|championship|playoffs?|final four|all-?star game|grammys?|oscars?|hanukkah|kwanzaa|diwali|cinco de mayo|mardi gras|lunar new year|chinese new year|bastille day|passover|eid|nba finals|stanley cup)\b/i;
const MAX_EVENT_CHECKS = 20;

async function isOccasionOutOfSeason(description: string): Promise<boolean> {
  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 200,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2, allowed_callers: ["direct"] }],
        messages: [
          {
            role: "user",
            content: `Today's date is ${new Date().toISOString().slice(0, 10)}. The product "${description}" appears to be merchandise tied to a specific event, holiday, or observance. Answer YES only if this is now genuinely hard to sell because: (a) a one-time event has already concluded, or (b) a recurring holiday's most recent occurrence has already passed and it's still months away from coming back around. Answer NO if the relevant occasion hasn't happened yet this year (buying seasonal stock a couple months ahead of a holiday is normal and NOT a reason to answer YES) or if it's close enough to be selling now. If genuinely unsure, answer UNSURE. Answer with exactly one word: YES, NO, or UNSURE.`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    // The model reasons through search results before its final verdict
    // (see extractText above) rather than leading with it, so check for a
    // standalone YES anywhere in the full answer rather than requiring it
    // as the very first word.
    const text = extractText(response.content).toUpperCase();
    return /\bYES\b/.test(text);
  } catch (e) {
    console.error(`[sourcingAgent] occasion-season check failed for "${description}"`, e);
    return false; // fail open — an unconfirmed guess is worse than no check at all
  }
}

// ---------------------------------------------------------------------------
// Per-UPC line estimate
// ---------------------------------------------------------------------------

type LineGroup = {
  upc: string | null;
  description: string;
  category: string | null;
  expectedQuantity: number;
  extendedRetail: number;
  retailPrice: number;
};

type LineEstimateResult = {
  upc: string | null;
  description: string;
  extendedRetail: number;
  estimatedUnitSalePrice: number | null;
  estimatedUnitFees: number | null;
  estimatedUnitShipping: number | null;
  estimatedNetPerUnit: number | null;
  effectiveUnits: number;
  typicalPackSize: number;
  dataConfidence: "own_history" | "category_fallback" | "market_only";
  flaggedDud: boolean;
  eventEnded: boolean;
  postHolidayFiller: boolean;
  trendNudge: string | null;
  seasonal: string | null;
};

async function estimateLine(
  group: LineGroup,
  receiveRate: number,
  runTrendCheck: boolean,
  eventCheckBudget: { remaining: number }
): Promise<LineEstimateResult> {
  // Own-history: exact UPC, across every manifest ever sold, not just this one.
  let ownSalesCount = 0;
  let ownAvgSalePrice = 0;
  let ownAvgShipping = 0;
  let ownFeeRate = FALLBACK_FEE_RATE;
  const ownPackSizes: number[] = [];
  if (group.upc) {
    const items = await prisma.item.findMany({
      where: { upc: group.upc, soldQuantity: { gt: 0 } },
      select: {
        soldQuantity: true,
        isMultipack: true,
        packSize: true,
        soldRevenueTotal: true,
        soldFeesTotal: true,
        soldShippingTotal: true,
      },
    });
    let units = 0;
    let revenue = 0;
    let fees = 0;
    let shipping = 0;
    for (const i of items) {
      const u = soldPhysicalUnits(i);
      units += u;
      revenue += Number(i.soldRevenueTotal);
      fees += Number(i.soldFeesTotal);
      shipping += Number(i.soldShippingTotal);
      // How this UPC was actually listed when we sold it before — the
      // most reliable signal there is for what a "listing" of it means.
      for (let n = 0; n < i.soldQuantity; n++) ownPackSizes.push(i.isMultipack && i.packSize ? i.packSize : 1);
    }
    if (units > 0) {
      ownSalesCount = units;
      ownAvgSalePrice = revenue / units;
      ownAvgShipping = shipping / units;
      ownFeeRate = revenue > 0 ? fees / revenue : FALLBACK_FEE_RATE;
    }
  }

  // Category rollup: other UPCs sharing this manifest line's category,
  // excluding the exact UPC already covered above.
  let categorySalesCount = 0;
  let categoryAvgSalePrice = 0;
  let categoryAvgShipping = 0;
  if (group.category) {
    const linesInCategory = await prisma.manifestLine.findMany({
      where: { category: group.category, upc: { not: group.upc } },
      select: { upc: true },
      distinct: ["upc"],
    });
    const upcs = linesInCategory.map((l) => l.upc).filter((u): u is string => Boolean(u));
    if (upcs.length > 0) {
      const items = await prisma.item.findMany({
        where: { upc: { in: upcs }, soldQuantity: { gt: 0 } },
        select: { soldQuantity: true, isMultipack: true, packSize: true, soldRevenueTotal: true, soldShippingTotal: true },
      });
      let units = 0;
      let revenue = 0;
      let shipping = 0;
      for (const i of items) {
        const u = soldPhysicalUnits(i);
        units += u;
        revenue += Number(i.soldRevenueTotal);
        shipping += Number(i.soldShippingTotal);
      }
      if (units > 0) {
        categorySalesCount = units;
        categoryAvgSalePrice = revenue / units;
        categoryAvgShipping = shipping / units;
      }
    }
  }

  // Live market signal — same shipping-inclusive comp search already built
  // for price research. Also the saturation signal for dud-flagging.
  //
  // Every comp's price is normalized to a per-unit basis by dividing out
  // its own detected pack size (see detectPackSize above) before it's
  // used — a "3-Pack" or "Lot of 2" is a normal listing a real buyer buys
  // directly, just priced for more than one unit. Only a genuine reseller/
  // wholesale lot (see isResellerLot) is excluded outright, since there's
  // no reliable way to translate business-to-business pricing into a
  // realistic retail per-unit number.
  let marketMedian = 0;
  let activeCompCount = 0;
  const marketPackSizes: number[] = [];
  try {
    const comps = await searchActiveListings({ upc: group.upc, keywords: group.description, excludeListingId: null });
    const perUnitPrices: number[] = [];
    for (const c of comps) {
      const packSize = detectPackSize(c.title);
      if (isResellerLot(c.title, packSize)) continue;
      marketPackSizes.push(packSize);
      perUnitPrices.push(c.totalPrice / packSize);
    }
    activeCompCount = perUnitPrices.length;
    if (perUnitPrices.length > 0) {
      perUnitPrices.sort((a, b) => a - b);
      const mid = Math.floor(perUnitPrices.length / 2);
      marketMedian = perUnitPrices.length % 2 === 0 ? (perUnitPrices[mid - 1] + perUnitPrices[mid]) / 2 : perUnitPrices[mid];
    }
  } catch (e) {
    if (!(e instanceof EbayApiError)) throw e;
    console.error(`[sourcingAgent] comp search failed for UPC ${group.upc}`, e);
  }

  // What this UPC is realistically LISTED as — own past sales are the most
  // reliable signal when we have them, otherwise the most common pack size
  // seen among live comps. Only matters for amortizing the flat per-listing
  // shipping/fixed-fee fallbacks below correctly (a percentage-of-price fee
  // needs no such adjustment — it already scales with the normalized price).
  const typicalPackSize = ownPackSizes.length > 0 ? modePackSize(ownPackSizes) : modePackSize(marketPackSizes);

  // Confidence-weighted blend — more real samples (capped) = more trust,
  // market signal always contributes some weight since it's always at least
  // directionally available.
  const ownScore = Math.min(ownSalesCount, 8) * 3;
  const categoryScore = Math.min(categorySalesCount, 15) * 1.5;
  const marketScore = Math.min(activeCompCount, 10) * 1;
  const totalScore = ownScore + categoryScore + marketScore;

  if (totalScore === 0) {
    // Nothing to go on at all — no comps, no history. Can't responsibly
    // estimate; treated as a dud (zero contribution) rather than guessed.
    return {
      upc: group.upc,
      description: group.description,
      extendedRetail: group.extendedRetail,
      estimatedUnitSalePrice: null,
      estimatedUnitFees: null,
      estimatedUnitShipping: null,
      estimatedNetPerUnit: null,
      effectiveUnits: Math.round(group.expectedQuantity * receiveRate),
      typicalPackSize,
      dataConfidence: "market_only",
      flaggedDud: true,
      eventEnded: false,
      postHolidayFiller: isPostHolidayFiller(group.description),
      trendNudge: null,
      seasonal: await seasonalNote(group.category, group.description),
    };
  }

  const dataConfidence: LineEstimateResult["dataConfidence"] =
    ownScore >= categoryScore && ownScore >= marketScore && ownSalesCount >= 3
      ? "own_history"
      : categoryScore > marketScore || ownSalesCount > 0
        ? "category_fallback"
        : "market_only";

  const blendedSalePrice =
    (ownScore * ownAvgSalePrice + categoryScore * categoryAvgSalePrice + marketScore * marketMedian) / totalScore;
  // market_only means there's no real sales history backing this number at
  // all — a comp with a pack size detectPackSize missed can still slip
  // through, so cap against the manifest's own declared retail as a
  // last-resort sanity check rather than trusting an implausible number
  // outright.
  const estimatedUnitSalePrice =
    dataConfidence === "market_only" && group.retailPrice > 0
      ? Math.min(blendedSalePrice, group.retailPrice * MARKET_ONLY_RETAIL_MULTIPLE_CAP)
      : blendedSalePrice;
  // FALLBACK_SHIPPING_COST/FALLBACK_FEE_FIXED are per-LISTING costs (one
  // shipment, one order) — dividing by typicalPackSize amortizes them
  // across the physical units in that listing, same reasoning as
  // normalizing comp prices above. ownAvgShipping needs no such
  // adjustment: it's a real recorded shipping cost already divided by
  // real physical units sold (soldPhysicalUnits), not a flat guess.
  const fallbackShippingPerUnit = FALLBACK_SHIPPING_COST / typicalPackSize;
  const fallbackFeeFixedPerUnit = FALLBACK_FEE_FIXED / typicalPackSize;
  const estimatedUnitShipping =
    ownSalesCount > 0 || categorySalesCount > 0
      ? (ownScore * ownAvgShipping + categoryScore * categoryAvgShipping + marketScore * fallbackShippingPerUnit) / totalScore
      : fallbackShippingPerUnit;
  const estimatedUnitFees = estimatedUnitSalePrice * ownFeeRate + fallbackFeeFixedPerUnit;
  const rawNet = estimatedUnitSalePrice - estimatedUnitFees - estimatedUnitShipping;

  // Dud: heavily saturated market (lots of active comps) with no real sales
  // history to back up that it actually moves, or the math is just negative.
  let flaggedDud = rawNet <= 0 || (ownSalesCount === 0 && categorySalesCount === 0 && activeCompCount >= 15);

  // Recurring-holiday filler (see POST_HOLIDAY_DUD_RULES above) — cheap,
  // no API call, calendar-based. Checked first so the live check below
  // never spends budget re-confirming something already resolved for free.
  const postHolidayFiller = isPostHolidayFiller(group.description);
  if (postHolidayFiller) flaggedDud = true;

  // Anything occasion-tied that isn't one of the hardcoded holidays above
  // (a one-time event, or a holiday we didn't think to hardcode) — active
  // comps right now don't mean real demand, they're as likely to be other
  // liquidators dumping the same dead stock. Overrides everything else
  // computed above: real sales history for this exact UPC would already
  // be reflected in ownAvgSalePrice (which only counts actual completed
  // sales), but a positive live-comp signal alone isn't trustworthy once
  // the occasion itself has passed.
  let eventEnded = false;
  if (!postHolidayFiller && OCCASION_MERCH_PATTERN.test(group.description) && eventCheckBudget.remaining > 0) {
    eventCheckBudget.remaining--;
    eventEnded = await isOccasionOutOfSeason(group.description);
    if (eventEnded) flaggedDud = true;
  }

  const trendNudge = runTrendCheck ? await getTrendNudge(group.description) : null;

  return {
    upc: group.upc,
    description: group.description,
    extendedRetail: group.extendedRetail,
    estimatedUnitSalePrice,
    estimatedUnitFees,
    estimatedUnitShipping,
    estimatedNetPerUnit: flaggedDud ? 0 : rawNet,
    effectiveUnits: Math.round(group.expectedQuantity * receiveRate),
    typicalPackSize,
    dataConfidence,
    flaggedDud,
    eventEnded,
    postHolidayFiller,
    trendNudge,
    seasonal: await seasonalNote(group.category, group.description),
  };
}

// ---------------------------------------------------------------------------
// Supplier reliability — real historical damage rate for this supplier,
// clamped so a supplier with little history yet doesn't produce an
// extreme haircut off one bad manifest.
// ---------------------------------------------------------------------------
async function getSupplierReceiveRate(supplier: ManifestSupplier): Promise<number> {
  const [damaged, expected] = await Promise.all([
    prisma.manifestDamagedEntry.aggregate({ _sum: { quantity: true }, where: { manifest: { supplier } } }),
    prisma.manifestLine.aggregate({ _sum: { expectedQuantity: true }, where: { manifest: { supplier } } }),
  ]);
  const damagedSum = damaged._sum.quantity ?? 0;
  const expectedSum = expected._sum.expectedQuantity ?? 0;
  if (expectedSum === 0) return 1; // no history yet — no haircut, matches "lean on market signal early" philosophy
  const rate = 1 - damagedSum / expectedSum;
  return Math.max(0.5, Math.min(1, rate));
}

// ---------------------------------------------------------------------------
// Main orchestrator — creates the SourcingEvaluation row's content. Caller
// (the API route) is responsible for creating the "running" row first and
// persisting this function's result.
// ---------------------------------------------------------------------------

const MAX_DEEP_RESEARCH_LINES = 150;
const MAX_TREND_CHECKS = 10;

export async function evaluateManifest(manifestId: string): Promise<{
  recommendation: "buy" | "dont_buy";
  maxBid: number;
  expectedNetContribution: number;
  reasoning: string;
  lineEstimates: LineEstimateResult[];
}> {
  const manifest = await prisma.manifest.findUniqueOrThrow({
    where: { id: manifestId },
    include: { lines: true },
  });

  const targetMarginPct = await getTargetMarginPct();
  const receiveRate = await getSupplierReceiveRate(manifest.supplier);

  // Group lines by UPC (duplicates collapse into one group) — a liquidation
  // manifest's line count usually collapses to far fewer unique UPCs.
  const groups = new Map<string, LineGroup>();
  for (const line of manifest.lines) {
    const key = line.upc ?? `__no_upc_${line.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.expectedQuantity += line.expectedQuantity;
      existing.extendedRetail += Number(line.extendedRetail);
    } else {
      groups.set(key, {
        upc: line.upc,
        description: line.description,
        category: line.category,
        expectedQuantity: line.expectedQuantity,
        extendedRetail: Number(line.extendedRetail),
        retailPrice: Number(line.retailPrice),
      });
    }
  }

  // Deep-research the top N by value; everything past that still counts
  // toward the total (via a cheap category/market-only pass, no per-line
  // trend check) so a huge manifest's economics aren't silently dropped.
  const sortedGroups = [...groups.values()].sort((a, b) => b.extendedRetail - a.extendedRetail);
  const deepGroups = sortedGroups.slice(0, MAX_DEEP_RESEARCH_LINES);
  const shallowGroups = sortedGroups.slice(MAX_DEEP_RESEARCH_LINES);

  const eventCheckBudget = { remaining: MAX_EVENT_CHECKS };
  const deepEstimates = await mapWithConcurrency(deepGroups, 5, async (group, index) =>
    estimateLine(group, receiveRate, index < MAX_TREND_CHECKS, eventCheckBudget)
  );
  const shallowEstimates = await mapWithConcurrency(shallowGroups, 5, (group) =>
    estimateLine(group, receiveRate, false, eventCheckBudget)
  );

  const lineEstimates = [...deepEstimates, ...shallowEstimates];

  let totalExpectedNetContribution = 0;
  for (const est of lineEstimates) {
    totalExpectedNetContribution += (est.estimatedNetPerUnit ?? 0) * est.effectiveUnits;
  }
  const dudCount = lineEstimates.filter((e) => e.flaggedDud).length;
  const dudShare = lineEstimates.length > 0 ? dudCount / lineEstimates.length : 0;

  // Concentration risk: is one UPC's retail value share large AND weak
  // (dud-flagged)? The spec explicitly prefers scattered manifests.
  const totalExtendedRetail = sortedGroups.reduce((sum, g) => sum + g.extendedRetail, 0);
  const topGroup = sortedGroups[0];
  const topEstimate = lineEstimates[0];
  const topShare = totalExtendedRetail > 0 && topGroup ? topGroup.extendedRetail / totalExtendedRetail : 0;
  const concentrationRisk = topShare > 0.35 && Boolean(topEstimate?.flaggedDud);

  const maxBid = Math.max(0, totalExpectedNetContribution / (1 + targetMarginPct / 100));

  // Buy/Don't-Buy is code-computed and deterministic — the LLM only
  // explains it afterward, never re-decides it, so the call stays
  // reproducible instead of depending on model sampling.
  const MIN_BID_FLOOR = 20; // below this it's not worth the trip/effort even if technically positive
  const recommendation: "buy" | "dont_buy" =
    maxBid >= MIN_BID_FLOOR && dudShare < 0.6 && !concentrationRisk ? "buy" : "dont_buy";

  const knowledgeScopes = [
    `supplier:${manifest.supplier}`,
    ...new Set(sortedGroups.map((g) => g.category).filter((c): c is string => Boolean(c)).map((c) => `category:${c}`)),
  ].slice(0, 10);
  const knowledgeNotes = await prisma.sourcingKnowledge.findMany({ where: { scope: { in: knowledgeScopes } } });

  const reasoning = await writeReasoning({
    manifestTitle: manifest.title,
    supplier: manifest.supplier,
    targetMarginPct,
    receiveRate,
    totalExpectedNetContribution,
    maxBid,
    recommendation,
    dudShare,
    concentrationRisk,
    topLines: lineEstimates
      .slice()
      .sort((a, b) => (b.estimatedNetPerUnit ?? 0) * b.effectiveUnits - (a.estimatedNetPerUnit ?? 0) * a.effectiveUnits)
      .slice(0, 8),
    dudLines: lineEstimates.filter((e) => e.flaggedDud).slice(0, 5),
    expiredEventLines: lineEstimates
      .filter((e) => e.eventEnded)
      .map((e) => `- ${e.description}`)
      .slice(0, 10),
    postHolidayLines: lineEstimates
      .filter((e) => e.postHolidayFiller)
      .map((e) => `- ${e.description}`)
      .slice(0, 10),
    knowledgeNotes: knowledgeNotes.map((n) => `[${n.scope}] ${n.notes}`),
    seasonalNotes: [...new Set(lineEstimates.map((e) => e.seasonal).filter((s): s is string => Boolean(s)))].slice(0, 3),
    trendNudges: lineEstimates
      .filter((e) => e.trendNudge)
      .map((e) => `${e.description}: ${e.trendNudge}`)
      .slice(0, MAX_TREND_CHECKS),
  });

  return { recommendation, maxBid, expectedNetContribution: totalExpectedNetContribution, reasoning, lineEstimates };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function writeReasoning(input: {
  manifestTitle: string;
  supplier: string;
  targetMarginPct: number;
  receiveRate: number;
  totalExpectedNetContribution: number;
  maxBid: number;
  recommendation: "buy" | "dont_buy";
  dudShare: number;
  concentrationRisk: boolean;
  topLines: LineEstimateResult[];
  dudLines: LineEstimateResult[];
  expiredEventLines: string[];
  postHolidayLines: string[];
  knowledgeNotes: string[];
  seasonalNotes: string[];
  trendNudges: string[];
}): Promise<string> {
  const prompt = `You are explaining a liquidation manifest sourcing decision that has ALREADY been computed. Do not redo the math or change the call — just write a clear, plain-language explanation a busy reseller can read in 10 seconds and trust.

Manifest: "${input.manifestTitle}" from ${input.supplier}
Call: ${input.recommendation.toUpperCase().replace("_", " ")}
Max recommended bid: $${input.maxBid.toFixed(2)}
Expected net contribution before bid cost: $${input.totalExpectedNetContribution.toFixed(2)}
Target margin used: ${input.targetMarginPct}%
Supplier's real historical receive rate (after damage/expired): ${(input.receiveRate * 100).toFixed(0)}%
Share of lines flagged as likely duds: ${(input.dudShare * 100).toFixed(0)}%
Concentration risk flagged: ${input.concentrationRisk ? "yes — one item dominates the manifest's value and looks weak" : "no"}

Top contributing lines:
${input.topLines.map((l) => `- ${l.description} (UPC ${l.upc ?? "n/a"}): est. $${l.estimatedNetPerUnit?.toFixed(2) ?? "?"} net/unit × ${l.effectiveUnits} units, confidence: ${l.dataConfidence}`).join("\n") || "none"}

Lines flagged as likely duds:
${input.dudLines.map((l) => `- ${l.description} (UPC ${l.upc ?? "n/a"})`).join("\n") || "none"}

Lines flagged as licensed merch for an event that has already concluded (treated as dead stock regardless of live comps):
${input.expiredEventLines.join("\n") || "none"}

Lines flagged as recurring-holiday filler found outside its real sell window (e.g. Christmas ornaments in spring, Halloween decor outside Aug-Oct) — treated as dead stock:
${input.postHolidayLines.join("\n") || "none"}

Accumulated notes from past manifests:
${input.knowledgeNotes.join("\n") || "none yet"}

Seasonal signals:
${input.seasonalNotes.join("\n") || "none notable"}

Trend signals (directional only, from live web search):
${input.trendNudges.join("\n") || "none notable"}

Write 3-6 sentences: which items drove the call, any supplier/category patterns applied, seasonal timing if relevant, and any trend signal factored in. Plain language, no bullet points, no restating the raw numbers verbatim.`;

  try {
    const response = await anthropic.messages.create(
      { model: "claude-opus-4-8", max_tokens: 600, messages: [{ role: "user", content: prompt }] },
      { timeout: 45_000, maxRetries: 0 }
    );
    const text = extractText(response.content).trim();
    return text || "Reasoning unavailable.";
  } catch (e) {
    console.error("[sourcingAgent] writeReasoning failed", e);
    return `${input.recommendation === "buy" ? "Buy" : "Don't buy"} — max bid $${input.maxBid.toFixed(2)} (reasoning text failed to generate, see line breakdown below).`;
  }
}

// ---------------------------------------------------------------------------
// Learning loop — hooked into the existing 4-hourly eBay order-sync cron.
// Only does real work (an LLM call) for scopes with genuinely new outcome
// data since their notes were last updated; otherwise a no-op.
// ---------------------------------------------------------------------------

export async function updateSourcingKnowledge(): Promise<void> {
  const suppliers: ManifestSupplier[] = ["bstock", "liquidation_com"];
  for (const supplier of suppliers) {
    await updateScopeKnowledge(`supplier:${supplier}`, async (since) => {
      const manifests = await prisma.manifest.findMany({
        where: { supplier, items: { some: { updatedAt: { gte: since } } } },
        select: { id: true, title: true },
        take: 20,
      });
      if (manifests.length === 0) return null;
      const rate = await getSupplierReceiveRate(supplier);
      return `Supplier ${supplier}: current real receive rate (after damage/expired) is ${(rate * 100).toFixed(0)}% across all manifests on record. ${manifests.length} manifest(s) had new activity recently.`;
    });
  }

  const categories = await prisma.manifestLine.findMany({
    where: { category: { not: null } },
    select: { category: true },
    distinct: ["category"],
    take: 30,
  });
  for (const { category } of categories) {
    if (!category) continue;
    await updateScopeKnowledge(`category:${category}`, async (since) => {
      const upcs = await prisma.manifestLine.findMany({ where: { category }, select: { upc: true }, distinct: ["upc"] });
      const upcList = upcs.map((u) => u.upc).filter((u): u is string => Boolean(u));
      if (upcList.length === 0) return null;
      const recentSales = await prisma.ebayItemSale.findMany({
        where: { item: { upc: { in: upcList } }, createdAt: { gte: since } },
        select: { revenue: true, fees: true, shipping: true },
      });
      if (recentSales.length === 0) return null;
      const revenue = recentSales.reduce((s, r) => s + Number(r.revenue), 0);
      const fees = recentSales.reduce((s, r) => s + Number(r.fees), 0);
      const shipping = recentSales.reduce((s, r) => s + Number(r.shipping), 0);
      const margin = revenue > 0 ? ((revenue - fees - shipping) / revenue) * 100 : 0;
      return `Category "${category}": ${recentSales.length} new sale(s) recorded, blended realized margin ~${margin.toFixed(0)}% after fees/shipping.`;
    });
  }
}

async function updateScopeKnowledge(scope: string, computeUpdate: (since: Date) => Promise<string | null>): Promise<void> {
  const existing = await prisma.sourcingKnowledge.findUnique({ where: { scope } });
  const since = existing?.updatedAt ?? new Date(0);
  const newFacts = await computeUpdate(since);
  if (!newFacts) return; // nothing new — skip, don't burn an LLM call

  if (!existing) {
    await prisma.sourcingKnowledge.create({ data: { scope, notes: newFacts } });
    return;
  }

  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: `You maintain a short running note about "${scope}" for a liquidation-reselling sourcing agent. Current notes:\n"${existing.notes}"\n\nNew data since last update:\n"${newFacts}"\n\nRewrite the notes to incorporate this, staying concise (3-4 sentences max) and focused on patterns useful for future buy/bid decisions — not a log of events.`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    const updated = extractText(response.content).trim();
    await prisma.sourcingKnowledge.update({ where: { scope }, data: { notes: updated || newFacts } });
  } catch (e) {
    console.error(`[sourcingAgent] updateScopeKnowledge failed for ${scope}`, e);
  }
}
