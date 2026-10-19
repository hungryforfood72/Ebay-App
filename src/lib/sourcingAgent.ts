import { EBAY_DATA_DOMAINS } from "./ebayDataDomains";
import { prisma } from "./prisma";
import {
  detectPackSize,
  FALLBACK_FEE_FIXED,
  FALLBACK_FEE_RATE,
  FALLBACK_SHIPPING_COST,
  isResellerLot,
  parsePackStats,
  recommendPackSize,
  summarizeComps,
  type PackStat,
} from "./packSize";
import { anthropic } from "./anthropic";
import { logAiUsage } from "./aiUsage";
import { advisePackSize } from "./packAdvisor";
import { EbayApiError, getBrowseCallsRemaining, getListingSales, searchActiveListings, searchActiveListingsBy, type ActiveListingComp } from "./ebay";
import { ebayBanReason } from "./ebayBanned";
import { ACCURACY_KNOWLEDGE_SCOPE, getCalibration } from "./predictionTracker";
import { boxesFor, exactSearchKeywords, isExactTitleMatch, LOT_TITLE, priceFromExactComps } from "./exactComps";
import type { ManifestSupplier } from "@/generated/prisma/client";
import { NOT_RETURN_ENTRY } from "./warehouse/returnReconcile";

// ---------------------------------------------------------------------------
// Settings (AppSetting key/value store)
// ---------------------------------------------------------------------------

const TARGET_MARGIN_KEY = "sourcing_target_margin_pct";
const DEFAULT_TARGET_MARGIN_PCT = 35;

// Below this a manifest just isn't worth the trip/effort even if the math
// is technically positive. Exported so the bid calculator UI can apply the
// exact same floor to a hypothetical price, rather than duplicating "20"
// as a second, driftable copy of this judgment call.
export const MIN_BID_FLOOR = 20;

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

// How many months of expected inventory at a line's recent real sell rate
// counts as "too slow, don't want to sit on that much stock" (see the
// slowMover flag in estimateLine) — Cristian's own framing: a good per-unit
// price doesn't mean much if 300 units only move 1/month.
const MAX_MONTHS_TO_SELL_THROUGH_KEY = "sourcing_max_months_to_sell_through";
const DEFAULT_MAX_MONTHS_TO_SELL_THROUGH = 6;

export async function getMaxMonthsToSellThrough(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: MAX_MONTHS_TO_SELL_THROUGH_KEY } });
  const value = row ? Number(row.value) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_MONTHS_TO_SELL_THROUGH;
}

// Slow-seller tiers, Cristian 2026-10-17: he's growing by rolling profit
// into more inventory, and most of it doesn't expire, so selling in 8-12
// months is still profit. But cash that sells in 2 months turns over ~6x
// a year, so slower stock only counts cheap:
//   sells within getMaxMonthsToSellThrough (6): full value, target margin
//   doesn't expire, sells within this (12): counted at the unproven margin
//   anything slower, or an expiring product past the first limit: dud
const LONG_TAIL_MONTHS_KEY = "sourcing_long_tail_months";
const DEFAULT_LONG_TAIL_MONTHS = 12;

export async function getLongTailMonths(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: LONG_TAIL_MONTHS_KEY } });
  const value = row ? Number(row.value) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LONG_TAIL_MONTHS;
}

export async function setLongTailMonths(months: number): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: LONG_TAIL_MONTHS_KEY },
    create: { key: LONG_TAIL_MONTHS_KEY, value: String(months) },
    update: { value: String(months) },
  });
}

// Products with a printed expiration date, by what they are. Built from the
// items Lizvet has actually entered dates for (vitamins, OTC medicine,
// sunscreen, food, eye drops and contact solution) vs ones she hasn't (hair
// color, bandages, school supplies, lip balm, hairspray). Liquidation.com
// shorthand can slip past it; our own scans of the UPC win when we have them.
const EXPIRING_PRODUCT =
  /\b(sunscreen|sunblock|spf|vitamins?|multivitamin|supplements?|softgels?|caplets?|tablets?|capsules?|gumm(y|ies)|probiotics?|ibuprofen|acetaminophen|naproxen|aspirin|antacid|laxative|allergy|antihistamine|cough|cold & flu|sinus|nasal spray|pain relie(f|ving)|eye drops?|dry eye|eye relief|artificial tears|lubricant eye|contact (lens )?solution|mouthwash|mouth rinse|oral rinse|saline|electrolytes?|protein|formula|baby food|snacks?|candy|chocolate|cookies?|chips|jerky|coffee|creamer|cappuccino|drink mix|energy drink|tuna|trail mix|nuts|pet food|dog food|cat food|treats)\b/i;

export async function expiresByDate(upc: string | null, description: string): Promise<boolean> {
  if (upc) {
    const scanned = await prisma.item.findMany({
      where: { upc, isBundle: false },
      select: { expirationDate: true },
      take: 20,
    });
    if (scanned.length > 0) return scanned.some((i) => i.expirationDate != null);
  }
  return EXPIRING_PRODUCT.test(description);
}

// Applies the tiers above. longTail = still counts, but only cheap.
export async function slowSellerTier(
  months: number | null,
  limits: SpeedLimits,
  upc: string | null,
  description: string
): Promise<{ slowMover: boolean; longTail: boolean }> {
  if (months == null || months <= limits.fullValueMonths) return { slowMover: false, longTail: false };
  if (months > limits.longTailMonths || (await expiresByDate(upc, description))) return { slowMover: true, longTail: false };
  return { slowMover: false, longTail: true };
}

type SpeedLimits = { fullValueMonths: number; longTailMonths: number };

export async function setMaxMonthsToSellThrough(months: number): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: MAX_MONTHS_TO_SELL_THROUGH_KEY },
    create: { key: MAX_MONTHS_TO_SELL_THROUGH_KEY, value: String(months) },
    update: { value: String(months) },
  });
}

// Margin required on lines with no sell-speed evidence at all (never sold
// by us, too few live listings to measure, no category sales). Cristian
// 2026-10-17: he'll still take a chance on those and doesn't mind them
// sitting on the shelf, but only at a really cheap price. 100% = pay at
// most half of what they're expected to net.
const UNPROVEN_MARGIN_KEY = "sourcing_unproven_margin_pct";
const DEFAULT_UNPROVEN_MARGIN_PCT = 100;

export async function getUnprovenMarginPct(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: UNPROVEN_MARGIN_KEY } });
  const value = row ? Number(row.value) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_UNPROVEN_MARGIN_PCT;
}

export async function setUnprovenMarginPct(pct: number): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: UNPROVEN_MARGIN_KEY },
    create: { key: UNPROVEN_MARGIN_KEY, value: String(pct) },
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

// A sale from last week should count more toward the estimated price than
// one from 11 months ago — prices drift, and a stale average understates
// what something actually sells for right now (Cristian's own example: sold
// for $25 a while back, currently going for $35 on eBay — the honest answer
// is somewhere in between, weighted toward the more recent number). Every
// per-sale price/shipping/fee average below is now a weighted average using
// this, not a flat mean. Exponential half-life rather than a hard cutoff —
// a sale never drops to literally zero weight, since some old evidence is
// still better than none for something rarely sold — just fades smoothly:
// a sale RECENCY_HALF_LIFE_DAYS old counts half as much as a brand-new one,
// twice that old a quarter, and so on.
const RECENCY_HALF_LIFE_DAYS = 120; // ~4 months — a judgment call, not derived from data

function recencyWeight(soldAt: Date): number {
  const daysAgo = (Date.now() - soldAt.getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, Math.max(0, daysAgo) / RECENCY_HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------------------
// Sell-through velocity — a good per-unit price doesn't mean much if the
// expected quantity would sit on the shelf for a year (Cristian's own
// framing: a line could be a great seller at that price but only move
// 1/month, and 300 units of that is 25 years of shelf space and cash tied
// up). Deliberately a plain recent-window rate (not the exponential-decay
// weighting used for price above) — easy to reason about and explain in the
// UI/reasoning text ("sells ~1/month based on the last 90 days"), and per-
// UPC/category sales are sparse enough that a hard window with a real
// sample is more legible than a smoothly-decaying one.
// ---------------------------------------------------------------------------
const VELOCITY_LOOKBACK_DAYS = 90;
// Infinity isn't a safe round-trip value through Prisma's Postgres Float
// mapping — used
// when a UPC/category has real sales history but literally zero of it
// happened within the recent window (selling has effectively stalled).
export const STALLED_MONTHS_SENTINEL = 9999;

// Physical units of `sales` sold within the last VELOCITY_LOOKBACK_DAYS,
// reusing whatever sales array the caller already fetched (own or
// category) rather than a second DB query.
function recentUnitsSold(sales: { quantity: number; soldAt: Date; item: { isMultipack: boolean; packSize: number | null } }[]): number {
  const cutoff = Date.now() - VELOCITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  let units = 0;
  for (const s of sales) {
    if (s.soldAt.getTime() < cutoff) continue;
    units += soldPhysicalUnits({ soldQuantity: s.quantity, isMultipack: s.item.isMultipack, packSize: s.item.packSize });
  }
  return units;
}

function computeMonthsToSellThrough(recentUnits: number, effectiveUnits: number): number {
  const unitsPerMonth = recentUnits / (VELOCITY_LOOKBACK_DAYS / 30);
  return unitsPerMonth > 0 ? effectiveUnits / unitsPerMonth : STALLED_MONTHS_SENTINEL;
}

// Market sell speed, for products we've never sold: how many units a
// typical live listing of it sells per month (its sold count over how long
// it's been up, averaged across a sample). Cristian's rule 2026-10-16: what
// he already has on hand must not decide a buy; the Analyzer's job is to
// tell whether the item itself sells, and his own sales take over once he
// has them. Replaced the old crowded-market rule, which dudded anything with
// lots of listings (popular items) and leaned on overall stock on hand.
// Being one more listing among N already splits demand N+1 ways, so the
// per-listing rate prices in competition.
// Leans low on purpose: a one-unit listing that sold is gone from search,
// so the survivors over-represent listings with 0 sold.
// Listings are checked SALES_BATCH_SIZE at a time, up to SALES_SAMPLE_SIZE:
// a second batch only when the first can't settle it (too few, or none
// sold). Each listing is one Browse call against a 5,000/day limit.
const SALES_SAMPLE_SIZE = 8;
const SALES_BATCH_SIZE = 4;
// Brand-new listings haven't had time to sell.
const MIN_LISTING_AGE_DAYS = 7;
const MIN_LISTINGS_FOR_RATE = 3;
// "Nobody sells any" needs a bigger sample than a positive rate does.
const MIN_LISTINGS_FOR_STALLED = 5;

type MarketSellRate = { unitsPerMonth: number | null; sampled: number };

// Corrections learned by the prediction tracker (src/lib/predictionTracker.ts)
// from bought manifests: actual / guessed, 1 = none.
type Calibration = { price: number; speed: number };

async function marketSellRate(comps: ActiveListingComp[]): Promise<MarketSellRate> {
  const sample = comps.filter((c) => !isResellerLot(c.title, detectPackSize(c.title))).slice(0, SALES_SAMPLE_SIZE);
  const rates: number[] = [];
  const average = () => (rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0);
  const enough = () =>
    rates.length >= MIN_LISTINGS_FOR_RATE && (average() > 0 || rates.length >= MIN_LISTINGS_FOR_STALLED);
  for (let start = 0; start < sample.length; start += SALES_BATCH_SIZE) {
    const batch = sample.slice(start, start + SALES_BATCH_SIZE);
    const sales = await Promise.all(batch.map((c) => getListingSales(c.itemId).catch(() => null)));
    batch.forEach((c, i) => {
      const s = sales[i];
      if (!s) return;
      const ageDays = (Date.now() - s.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < MIN_LISTING_AGE_DAYS) return;
      rates.push((s.soldQuantity * detectPackSize(c.title)) / (ageDays / 30));
    });
    if (enough() && average() > 0) break;
  }
  return { unitsPerMonth: enough() ? average() : null, sampled: rates.length };
}

function monthsAtMarketRate(rate: MarketSellRate | null, physicalUnits: number, speedCalibration: number): number | null {
  if (rate?.unitsPerMonth == null) return null;
  const unitsPerMonth = rate.unitsPerMonth * speedCalibration;
  return unitsPerMonth > 0 ? physicalUnits / unitsPerMonth : STALLED_MONTHS_SENTINEL;
}

// Selling-cost fallbacks and pack-size reading live in ./packSize, shared
// with the scan page's pack suggestion.

// Manifest descriptions in this app's CSVs are catalog-style and
// consistently lead with the brand ("Sun Bum SPF 50...", "First Response
// Early Pregnancy Test...", "Wexford Pink Erasers...") rather than being a
// sentence — so the first couple of real (non-numeric, non-trivial) tokens
// double as a decent brand/product match key against HistoricalSaleRecord
// titles, which have no UPC to join on. Best-effort and approximate by
// design (see the HistoricalSaleRecord model comment) — this is a
// directional signal, not a precise match.
const BRAND_MATCH_STOPWORDS = new Set(["new", "set", "mini", "the", "and", "for", "with", "pack", "kit"]);

// Ordinary words that often lead a manifest description without being a
// brand — fine as half of a two-word match, but matching on one of these
// alone pulls in every past sale that happens to use it ("Party Beverage
// Serviettes" -> any "party" sale; "Water Blaster" -> any "water" sale).
const GENERIC_LEAD_WORDS = new Set([
  "party", "water", "air", "baby", "kids", "kid", "women", "womens", "men", "mens", "girls", "boys",
  "original", "classic", "premium", "travel", "large", "small", "medium", "value", "bundle", "lot",
  "assorted", "ast", "holiday", "gift", "home", "light", "black", "white", "pink", "blue", "red",
]);

// Up to two leading match words, plus whether the first one can stand on
// its own as a brand: it has to be the description's very first word (where
// catalog-style names put the brand) and not a generic one. A cryptic
// abbreviation like "SH SE PM OV OUT OF THIS PRL" otherwise surfaced "OUT"
// and "THIS" as its "brand".
function extractBrandMatchWords(description: string): { words: string[]; firstIsBrand: boolean } {
  const tokens = description.replace(/[^a-zA-Z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const words = tokens
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !BRAND_MATCH_STOPWORDS.has(w.toLowerCase()))
    .slice(0, 2);
  const firstIsBrand =
    words.length > 0 && tokens[0] === words[0] && !GENERIC_LEAD_WORDS.has(words[0].toLowerCase());
  return { words, firstIsBrand };
}

// Whole-word, case-insensitive — the DB query's `contains` is a substring
// match, so "air" also finds "hair"/"repair"/"chair". Applied on top of it.
function titleHasWords(title: string, words: string[]): boolean {
  return words.every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(title));
}

// How long a market snapshot stays "fresh enough" to reuse instead of
// re-querying eBay's Browse API for the same UPC — see MarketCompSnapshot.
// Long enough that re-running the same (or another) manifest containing the
// same UPC multiple times in a day doesn't re-burn API calls (confirmed
// live: this was the actual cause of a 7,190-call day against a 5,000/day
// limit), short enough that the "trend since last check" comparison still
// means something.
const MARKET_SNAPSHOT_FRESHNESS_HOURS = 24;
// Below this, a price/listing-count difference between two snapshots is
// treated as normal day-to-day noise, not a real trend worth mentioning.
const MARKET_TREND_NOTABLE_PCT = 15;

function marketTrendNote(
  previous: { activeCompCount: number; medianPrice: number | null },
  current: { activeCompCount: number; medianPrice: number },
  daysAgo: number
): string | null {
  if (previous.medianPrice == null || previous.medianPrice <= 0 || current.medianPrice <= 0) return null;
  const priceChangePct = ((current.medianPrice - previous.medianPrice) / previous.medianPrice) * 100;
  if (Math.abs(priceChangePct) < MARKET_TREND_NOTABLE_PCT) return null;
  const direction = priceChangePct > 0 ? "up" : "down";
  const roundedDays = Math.max(1, Math.round(daysAgo));
  return `live asking price ${direction} ${Math.abs(priceChangePct).toFixed(0)}% since we last checked this UPC ${roundedDays} day${roundedDays === 1 ? "" : "s"} ago`;
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

// When an estimate isn't backed by our own sales of this exact UPC, a
// per-unit price more than this many times the manifest's own declared
// retail is far more likely a matching error than a genuine "sells above
// retail" item — liquidation merchandise rarely does. Capped, not
// discarded, so the line still contributes something rather than being
// silently zeroed.
//
// Was 3x, and applied only to market_only/web_price_check. Cristian caught
// both gaps on a real manifest (2026-09-26): 13 cryptically-named sock
// packs ("GMI ALEXA ROS LDIES NO SHW SC", $5.99 retail) priced at exactly
// 3x retail off multipack comps, making it the manifest's single biggest
// line; and historical_match lines with no cap at all pricing a $2.99
// napkin pack at $34 and a $3.16 mystery capsule at $38 off unrelated
// same-word sales. Our own real sales, compared against manifest retail,
// topped out at 1.44x.
const UNVERIFIED_RETAIL_MULTIPLE_CAP = 1.5;

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
// Analyzer Beta: pricing inside eBay's API License (2026-10-18). The
// license bars using eBay Content "to suggest or model prices for items
// listed on eBay" (sec. 9), and deriving seller performance or success
// rates without eBay's written permission (8.1(d)). eBay Content excludes
// information obtained independent of eBay. So a beta evaluation (a manifest
// with analyzerBeta) never calls the Browse API, reads or writes
// MarketCompSnapshot, or looks at other sellers' sold counts. It prices from
// Cristian's own sales (his own information), the manifest's retail, and
// web research with eBay's sites (and sites that resell eBay sold data)
// blocked. The standard Analyzer is unchanged.
// ---------------------------------------------------------------------------

function webSearchTool(compliant: boolean) {
  return {
    type: "web_search_20260209" as const,
    name: "web_search" as const,
    max_uses: 2,
    allowed_callers: ["direct" as const],
    ...(compliant ? { blocked_domains: EBAY_DATA_DOMAINS } : {}),
  };
}

// ---------------------------------------------------------------------------
// Research memory — every web-search finding is kept in ResearchObservation
// so the agent learns items over time instead of paying to re-research the
// same product on every manifest (see that model's schema comment). A
// finding whose underlying web data is recent enough is reused outright;
// an older price finding is handed back to the model as dated background
// and the model decides whether it still holds or needs a fresh search.
// Cristian's explicit ask: old data informs the answer, it isn't blindly
// copied, since a price from 6 months ago may no longer be right.
// ---------------------------------------------------------------------------

type ResearchKind = "price" | "event" | "trend";
type ResearchSubject = { upc: string | null; description: string };

// Web data younger than this is reused with no API call at all. Also what
// makes re-running the same manifest nearly free.
const PRICE_REUSE_DAYS = 14;
// Earlier price findings older than this are still shown to the model, but
// it's told to search again rather than lean on them.
const PRICE_STALE_DAYS = 120;
// Event status and trend signals move faster than prices (a holiday
// passes, a spike fades), so they're only ever reused while fresh.
const EVENT_REUSE_DAYS = 7;
const TREND_REUSE_DAYS = 7;
const PRIOR_FINDINGS_SHOWN = 5;

function descriptionKey(description: string): string {
  return description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function daysSince(date: Date): number {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
}

// Each Analyzer reads only its own findings (see ResearchObservation.compliant).
async function priorResearch(kind: ResearchKind, subject: ResearchSubject, compliant: boolean) {
  return prisma.researchObservation.findMany({
    where: subject.upc
      ? { kind, upc: subject.upc, compliant }
      : { kind, descriptionKey: descriptionKey(subject.description), compliant },
    orderBy: { createdAt: "desc" },
    take: PRIOR_FINDINGS_SHOWN,
  });
}

async function recordResearch(
  kind: ResearchKind,
  subject: ResearchSubject,
  finding: { price?: number | null; verdict?: string; note?: string | null; searched: boolean; basisAt: Date },
  // null = not part of an Analyzer run (a scan-page check).
  evaluationId: string | null,
  compliant: boolean
): Promise<void> {
  try {
    await prisma.researchObservation.create({
      data: {
        kind,
        upc: subject.upc,
        descriptionKey: descriptionKey(subject.description),
        description: subject.description,
        price: finding.price ?? null,
        verdict: finding.verdict ?? null,
        note: finding.note ?? null,
        searched: finding.searched,
        basisAt: finding.basisAt,
        evaluationId,
        compliant,
      },
    });
  } catch (e) {
    console.error(`[sourcingAgent] failed to record ${kind} research for "${subject.description}"`, e);
  }
}

function didSearch(response: { usage: { server_tool_use?: { web_search_requests: number } | null } }): boolean {
  return (response.usage.server_tool_use?.web_search_requests ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Trend signal — directional only, never overrides real sales history.
// Uses Anthropic's server-side web search tool (executed entirely within
// one API call, no client-side tool loop needed). Best-effort: a failure
// here just means no trend nudge for that line, not a failed evaluation.
// ---------------------------------------------------------------------------
async function getTrendNudge(subject: ResearchSubject, evaluationId: string, compliant: boolean): Promise<string | null> {
  const [latest] = await priorResearch("trend", subject, compliant);
  if (latest?.verdict && daysSince(latest.basisAt) <= TREND_REUSE_DAYS) {
    return latest.verdict === "NONE" ? null : latest.verdict;
  }
  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 300,
        tools: [webSearchTool(compliant)],
        messages: [
          {
            role: "user",
            content: `Is "${subject.description}" currently seeing any notable spike or dropoff in search/social interest or demand? Answer in one short sentence, plainly stating up, down, or no notable signal. If you can't find anything meaningful, just say "No notable signal."`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    await logAiUsage("sourcing.trend_check", response, { evaluationId });
    const text = extractText(response.content).trim();
    if (!text) return null;
    const signal = /no notable signal/i.test(text) ? null : text;
    await recordResearch(
      "trend",
      subject,
      { verdict: signal ?? "NONE", searched: didSearch(response), basisAt: new Date() },
      evaluationId,
      compliant
    );
    return signal;
  } catch (e) {
    console.error(`[sourcingAgent] trend nudge failed for "${subject.description}"`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live price check — for a line that would otherwise be priced off nothing
// more specific than its whole category's average (no real own or
// historical sales for this exact product), a category average can be a bad
// predictor for something whose price varies a lot within its category
// (Cristian's own example: skincare/cosmetics — confirmed live, an RoC eye
// cream priced by category average at $28.95 when his own manual check put
// it at $16-19). eBay exposes no sold-comps API at all (only currently-
// active listings — see the comment on searchActiveListings' caller above),
// so this is the closest available substitute: ask the model to search for
// what this specific product actually goes for, the same server-side
// web-search mechanism already used for the trend/event checks above.
// Best-effort — a failure or an unparseable answer just means the line
// keeps its plain category-fallback price, not a failed evaluation.
//
// Checks research memory first (see "Research memory" above): recent web
// data is reused with no call, older findings go into the prompt as dated
// background the model can answer from or choose to re-check.
// ---------------------------------------------------------------------------
// demand: the beta's outside-eBay read of how well it sells (see
// DemandTier). Always null for the standard Analyzer.
type WebCheck = { price: number | null; demand: DemandTier | null; note?: string | null };

async function getWebPriceCheck(subject: ResearchSubject, evaluationId: string | null, compliant: boolean): Promise<WebCheck> {
  const prior = await priorResearch("price", subject, compliant);
  const latest = prior[0];
  // A beta finding from before the demand read existed (verdict null) is
  // checked again, so it gets one.
  if (latest && daysSince(latest.basisAt) <= PRICE_REUSE_DAYS && (!compliant || latest.verdict != null)) {
    return {
      price: latest.price != null ? Number(latest.price) : null,
      demand: compliant ? parseDemandTier(latest.verdict) : null,
      note: latest.note,
    };
  }

  // The newest web data any earlier finding rests on — what a no-search
  // answer this time would itself be resting on.
  const newestBasis = prior.reduce<Date | null>((max, p) => (!max || p.basisAt > max ? p.basisAt : max), null);
  let priorBlock = "";
  if (prior.length > 0) {
    const lines = prior.map((p) => {
      const age = Math.round(daysSince(p.basisAt));
      const how = p.searched ? "web search" : "judged from earlier findings, no new search";
      const price = p.price != null ? `$${Number(p.price).toFixed(2)}` : "couldn't price it";
      const demand = compliant && p.verdict ? `, demand ${p.verdict}` : "";
      return `- ${p.basisAt.toISOString().slice(0, 10)} (${age} days ago, ${how}): ${price}${demand}${p.note ? `. ${p.note}` : ""}`;
    });
    const stale = newestBasis != null && daysSince(newestBasis) > PRICE_STALE_DAYS;
    priorBlock = `

We've researched this item before (newest first):
${lines.join("\n")}

${
  stale
    ? "All of that is over 4 months old, so search again and treat it only as a rough reference."
    : "Use this as your starting point. If it gives you a solid basis and nothing suggests this kind of product's price moves quickly, you can answer from it without searching. Search again if it's thin, contradictory, or the item is the kind whose price shifts fast."
}`;
  }

  try {
    const response = await anthropic.messages.create(
      {
        // Stays on Haiku 4.5: tested 2026-10-08 against 20 real sale prices,
        // Haiku 5.5 priced ~17% low (median miss 23% vs 13%), which would
        // drag bids down; its ~$11/month token saving isn't worth that.
        // 400 tokens cut 3 of those 20 off before the PRICE line (a line
        // with no price); 1000 let all 20 finish.
        model: "claude-haiku-4-5",
        max_tokens: 1000,
        tools: [webSearchTool(compliant)],
        messages: [
          {
            role: "user",
            content: compliant
              ? compliantPriceCheckPrompt(subject.description, prior.length > 0, priorBlock)
              : `You're pricing a liquidation/resale item. What would "${subject.description}" realistically sell for right now on eBay?

${prior.length > 0 ? "" : "Search for it. "}If you find actual current listing or sold prices, use those. If you only find retail/list price, give your best realistic estimate of what a liquidation reseller would actually get for it on eBay (typically well below retail — liquidation/secondhand goods commonly sell in the 40-70% of retail range, more or less depending on the category and condition) rather than the retail price itself.

Only answer UNKNOWN if you cannot even identify what kind of product this is or find any retail price to reason from — a rough estimate reasoned from retail price is far more useful here than no answer, so commit to your best number whenever you have ANY basis for one.${priorBlock}

End your response with EXACTLY these two lines and nothing after them:
NOTE: one short line on what your answer is based on (e.g. "4 active listings $12-16, retail $24")
PRICE: 17.50 (a plain number, no currency symbol) or PRICE: UNKNOWN`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    await logAiUsage(evaluationId ? "sourcing.price_check" : "scan.price_check", response, { evaluationId: evaluationId ?? undefined });
    // Confirmed live: the model sometimes echoes a retail price it found
    // earlier using the same "PRICE:" phrasing while reasoning toward its
    // real answer, and a plain (non-global) match grabs that FIRST
    // occurrence instead of the actual final verdict the prompt asks for.
    // Anchored to the literal last line instead of searching the whole text
    // for any "PRICE:"-shaped string.
    const lines = extractText(response.content)
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const lastLine = lines.pop() ?? "";
    // Only a committed final answer (a number or UNKNOWN) is worth
    // remembering — a response that never got to its PRICE line isn't a
    // finding.
    if (!/PRICE:\s*(\$?\d|UNKNOWN)/i.test(lastLine)) return { price: null, demand: null };
    const match = lastLine.match(/PRICE:\s*\$?(\d+(?:\.\d{1,2})?)/i);
    const parsed = match ? Number(match[1]) : NaN;
    const price = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    // The beta answers NOTE, DEMAND, PRICE; the standard check NOTE, PRICE.
    const demandLine = compliant && /^DEMAND:/i.test(lines.at(-1) ?? "") ? lines.pop()! : null;
    const demandWord = demandLine?.replace(/^DEMAND:\s*/i, "").match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "UNKNOWN";
    const noteLine = lines.pop() ?? "";
    const note = /^NOTE:/i.test(noteLine) ? noteLine.replace(/^NOTE:\s*/i, "").slice(0, 300) : null;
    const searched = didSearch(response);
    await recordResearch(
      "price",
      subject,
      {
        price,
        note,
        searched,
        basisAt: searched || !newestBasis ? new Date() : newestBasis,
        ...(compliant ? { verdict: parseDemandTier(demandWord) ?? "UNKNOWN" } : {}),
      },
      evaluationId,
      compliant
    );
    return { price, demand: compliant ? parseDemandTier(demandWord) : null, note };
  } catch (e) {
    console.error(`[sourcingAgent] web price check failed for "${subject.description}"`, e);
    return { price: null, demand: null };
  }
}

// The scan page's read on a product nobody's decided yet (scanned with no
// manifest, or a manifest line the Analyzer never got to). Same eBay-free
// check as the live Analyzer: store prices and demand signals from outside
// eBay (Cristian, 2026-10-19: replaces the scan page's search of other
// sellers' eBay listings, which the API License doesn't allow). Shares the
// Analyzer's research memory, so a product either one already checked in
// the last 14 days costs nothing.
export type ScanMarketCheck = { pricePerUnit: number | null; demand: DemandTier | null; note: string | null };

// cachedOnly: answer from research already on file (fresh enough to reuse)
// and never search; null when there's none.
export async function scanMarketCheck(
  subject: { upc: string; description: string },
  opts: { cachedOnly?: boolean } = {}
): Promise<ScanMarketCheck | null> {
  if (opts.cachedOnly) {
    const [latest] = await priorResearch("price", subject, true);
    if (!latest || latest.verdict == null || daysSince(latest.basisAt) > PRICE_REUSE_DAYS) return null;
    return { pricePerUnit: latest.price != null ? Number(latest.price) : null, demand: parseDemandTier(latest.verdict), note: latest.note };
  }
  const check = await getWebPriceCheck(subject, null, true);
  return { pricePerUnit: check.price, demand: check.demand, note: check.note ?? null };
}

export type { DemandTier };

// ---------------------------------------------------------------------------
// The beta's "will it sell" read (Cristian, 2026-10-18: that's what the
// Analyzer is mainly for; he prices items himself at review). Other sellers'
// sold counts are off limits (license 8.1(d)), so the beta's price check
// also rates demand from signals outside eBay: Amazon's "bought in past
// month" badge, Best Sellers Rank, reviews, whether stores still carry it.
// Each tier stands for a rough pace one seller's listing could sell at,
// which goes through the same slow-seller tiers as every other sell rate.
// Judgment numbers, not measured: the prediction tracker's beta speed
// correction (beta_speed) adjusts them once bought loads show real pace.
// ---------------------------------------------------------------------------
type DemandTier = "FAST" | "NORMAL" | "SLOW" | "DEAD";

const DEMAND_UNITS_PER_MONTH: Record<DemandTier, number> = {
  FAST: 20,
  NORMAL: 6,
  SLOW: 1.5,
  DEAD: 0,
};

function parseDemandTier(word: string | null | undefined): DemandTier | null {
  return word === "FAST" || word === "NORMAL" || word === "SLOW" || word === "DEAD" ? word : null;
}

function monthsAtDemandTier(tier: DemandTier, units: number, speedCalibration: number): number {
  const unitsPerMonth = DEMAND_UNITS_PER_MONTH[tier] * speedCalibration;
  return unitsPerMonth > 0 ? units / unitsPerMonth : STALLED_MONTHS_SENTINEL;
}

// The beta's price check. Same answer format as the standard one, but it
// reasons from store prices and never from eBay: eBay's sites are blocked
// in the search itself (webSearchTool), and the prompt tells the model to
// ignore any eBay price it comes across anyway.
function compliantPriceCheckPrompt(description: string, hasPrior: boolean, priorBlock: string): string {
  return `You're estimating what a liquidation reseller would realistically get for "${description}" (new, unused) when selling it online.

${hasPrior ? "" : "Search for it. "}Base the estimate on what the product costs new at regular stores and retailer websites (Amazon, Walmart, Target, drugstores, the brand's own site), then work out a realistic resale price: liquidation goods commonly sell for roughly 40-70% of the usual store price, lower for everyday items people can grab at any store, higher for things that are hard to find, discontinued or in demand.

Do NOT use eBay listings, eBay sold prices, or any site that reports eBay prices. If you come across one, ignore it.

Only answer UNKNOWN if you cannot even identify what kind of product this is or find any store price to reason from. A rough estimate reasoned from the store price is far more useful here than no answer, so commit to your best number whenever you have ANY basis for one.

Also judge how well this product sells right now, from signals outside eBay: Amazon's "bought in past month" badge, its Best Sellers Rank, how many reviews it has and whether they're recent, whether major stores still carry it, and whether it's discontinued, recalled or tied to an occasion that has passed. Rate it:
- FAST: clearly popular (e.g. thousands bought a month on Amazon, near the top of its category)
- NORMAL: a steady seller (e.g. hundreds bought a month, plenty of recent reviews, widely stocked)
- SLOW: niche or fading (few signs of recent buying, poor rank, very specialized, or discontinued with little interest)
- DEAD: no real sign anyone buys it now
- UNKNOWN: you can't tell
Judge demand for the product itself, not what it costs.${priorBlock}

End your response with EXACTLY these three lines and nothing after them:
NOTE: one short line on what your answer is based on (e.g. "Walmart $9.97, Target $10.49; Amazon 2K+ bought past month")
DEMAND: FAST, NORMAL, SLOW, DEAD or UNKNOWN
PRICE: 17.50 (a plain number, no currency symbol) or PRICE: UNKNOWN`;
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

// `used` counts real calls at the moment one is spent. An earlier version
// worked it out per line as remaining-before minus remaining-after, which
// with 5 lines in flight at once also counted the other lines' calls, so
// eventChecksUsed read 40 on a run that made at most 20.
type EventCheckBudget = { remaining: number; used: number };

async function isOccasionOutOfSeason(
  subject: ResearchSubject,
  evaluationId: string,
  budget: EventCheckBudget,
  compliant: boolean
): Promise<boolean> {
  // A fresh answer from memory costs nothing, so it doesn't touch the budget.
  const [latest] = await priorResearch("event", subject, compliant);
  if (latest?.verdict && daysSince(latest.basisAt) <= EVENT_REUSE_DAYS) {
    return latest.verdict === "YES";
  }
  if (budget.remaining <= 0) return false;
  budget.remaining--;
  budget.used++;
  const description = subject.description;
  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 200,
        tools: [webSearchTool(compliant)],
        messages: [
          {
            role: "user",
            content: `Today's date is ${new Date().toISOString().slice(0, 10)}. The product "${description}" appears to be merchandise tied to a specific event, holiday, or observance. Answer YES only if this is now genuinely hard to sell because: (a) a one-time event has already concluded, or (b) a recurring holiday's most recent occurrence has already passed and it's still months away from coming back around. Answer NO if the relevant occasion hasn't happened yet this year (buying seasonal stock a couple months ahead of a holiday is normal and NOT a reason to answer YES) or if it's close enough to be selling now. If genuinely unsure, answer UNSURE. Answer with exactly one word: YES, NO, or UNSURE.`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    await logAiUsage("sourcing.event_check", response, { evaluationId });
    // The model reasons through search results before its final verdict
    // (see extractText above) rather than leading with it, so check for a
    // standalone YES anywhere in the full answer rather than requiring it
    // as the very first word.
    const text = extractText(response.content).toUpperCase();
    const verdict = /\bYES\b/.test(text) ? "YES" : /\bNO\b/.test(text) ? "NO" : "UNSURE";
    await recordResearch("event", subject, { verdict, searched: didSearch(response), basisAt: new Date() }, evaluationId, compliant);
    return verdict === "YES";
  } catch (e) {
    console.error(`[sourcingAgent] occasion-season check failed for "${description}"`, e);
    return false; // fail open — an unconfirmed guess is worse than no check at all
  }
}

// ---------------------------------------------------------------------------
// Per-UPC line estimate
// ---------------------------------------------------------------------------

type LineGroup = {
  // Same key manifest lines were collapsed by (a UPC, or a synthetic
  // `__no_upc_<lineId>` for lines with none) — carried on the group itself
  // so it survives the Map → array conversion below and can be persisted on
  // each line's SourcingLineEstimate row for cross-invocation resume.
  groupKey: string;
  upc: string | null;
  description: string;
  category: string | null;
  expectedQuantity: number;
  extendedRetail: number;
  retailPrice: number;
  // Other-supplier manifests only (supplier "unknown") — see
  // estimateOtherSupplierLine. strictPricing switches to that path; the
  // rest feed it.
  strictPricing: boolean;
  supplierSku: string | null;
  piecesPerBox: number | null;
  boxes: number;
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
  // See recommendPackSize (./packSize) — null when there's too little to go on.
  recommendedPackSize: number | null;
  recommendedPackBasis: "agent" | "listings" | "estimate" | null;
  // retail_estimate / unpriced: Analyzer Beta only (see BetaPricing).
  dataConfidence:
    | "own_history"
    | "historical_match"
    | "web_price_check"
    | "category_fallback"
    | "market_only"
    | "exact_match"
    | "retail_estimate"
    | "unpriced";
  flaggedDud: boolean;
  marketCheckFailed: boolean;
  marketTrend: string | null;
  eventEnded: boolean;
  postHolidayFiller: boolean;
  trendNudge: string | null;
  seasonal: string | null;
  slowMover: boolean;
  monthsToSellThrough: number | null;
  // Sells too slowly for full value but is kept at the cheap margin (see
  // slowSellerTier).
  longTail?: boolean;
  // Where monthsToSellThrough came from, and the market rate when measured.
  // web_demand: Analyzer Beta only (see DemandTier).
  sellRateSource?: SellRateSource | null;
  listingUnitsPerMonth?: number | null;
};

type SellRateSource = "own" | "ebay_listings" | "web_demand" | "category";

// Other-supplier manifests (supplier "unknown", uploaded through the
// column mapper). Cristian's call 2026-10-15: these three fixes apply ONLY
// here — BStock / Liquidation.com keep estimateLine's blend below.
//   1. Priced by the box eBay sells (group.boxes, see sellableBoxSize),
//      not by loose pieces.
//   2. Only exact comps: under the UPC, or titled with the item's own
//      number; lots skipped (see exactComps.ts). No exact listing = no
//      price, never a borrowed one.
//   3. Stand-in for the retail cap (most of these manifests list no
//      retail): 1–2 exact listings use the lowest price, not the median.
//      When retail is given, the usual cap applies per box.
// Sell speed comes from the exact listings' own sold counts (marketSellRate).
async function estimateOtherSupplierLine(
  group: LineGroup,
  receiveRate: number,
  limits: SpeedLimits,
  calibration: Calibration
): Promise<LineEstimateResult> {
  const effectiveUnits = Math.round(group.boxes * receiveRate);
  const base = {
    upc: group.upc,
    description: group.description,
    extendedRetail: group.extendedRetail,
    effectiveUnits,
    typicalPackSize: 1,
    recommendedPackSize: null,
    recommendedPackBasis: null,
    dataConfidence: "exact_match" as const,
    marketTrend: null,
    eventEnded: false,
    postHolidayFiller: isPostHolidayFiller(group.description),
    trendNudge: null,
    seasonal: null,
    slowMover: false,
    monthsToSellThrough: null,
  };

  const comps: ActiveListingComp[] = [];
  try {
    const [byUpc, byKeywords] = await Promise.all([
      group.upc && /^\d{12,14}$/.test(group.upc) ? searchActiveListingsBy({ gtin: group.upc }) : Promise.resolve([]),
      searchActiveListingsBy({ keywords: exactSearchKeywords(group.description, group.supplierSku) }),
    ]);
    const seen = new Set<string>();
    for (const c of [...byUpc, ...byKeywords.filter((c) => isExactTitleMatch(c.title, group.description, group.supplierSku))]) {
      if (seen.has(c.itemId) || LOT_TITLE.test(c.title)) continue;
      seen.add(c.itemId);
      comps.push(c);
    }
  } catch (e) {
    if (!(e instanceof EbayApiError)) throw e;
    console.error(`[sourcingAgent] exact comp search failed for "${group.description}"`, e);
    // Unknown, not a confirmed dud — same reasoning as estimateLine.
    return {
      ...base,
      estimatedUnitSalePrice: null,
      estimatedUnitFees: null,
      estimatedUnitShipping: null,
      estimatedNetPerUnit: null,
      flaggedDud: false,
      marketCheckFailed: true,
    };
  }

  const { price: rawPrice } = priceFromExactComps(comps.map((c) => c.totalPrice));
  if (rawPrice == null) {
    return {
      ...base,
      estimatedUnitSalePrice: null,
      estimatedUnitFees: null,
      estimatedUnitShipping: null,
      estimatedNetPerUnit: 0,
      flaggedDud: true,
      marketCheckFailed: false,
    };
  }
  // Manifest retail is per piece; the cap is per box.
  const price =
    group.retailPrice > 0
      ? Math.min(rawPrice, group.retailPrice * (group.piecesPerBox ?? 1) * UNVERIFIED_RETAIL_MULTIPLE_CAP)
      : rawPrice;
  const fees = price * FALLBACK_FEE_RATE + FALLBACK_FEE_FIXED;
  const net = price - fees - FALLBACK_SHIPPING_COST;
  // Comps here are priced per box, so the rate is boxes per month. Only
  // measured when the price math works, to save eBay calls.
  const sellRate: MarketSellRate | null = net > 0 ? await marketSellRate(comps) : null;
  const monthsToSellThrough = monthsAtMarketRate(sellRate, effectiveUnits, calibration.speed);
  const { slowMover, longTail } = await slowSellerTier(monthsToSellThrough, limits, group.upc, group.description);
  const flaggedDud = net <= 0 || slowMover || base.postHolidayFiller;
  return {
    ...base,
    slowMover,
    longTail,
    monthsToSellThrough,
    sellRateSource: monthsToSellThrough != null ? "ebay_listings" : null,
    listingUnitsPerMonth: sellRate?.unitsPerMonth ?? null,
    estimatedUnitSalePrice: price,
    estimatedUnitFees: fees,
    estimatedUnitShipping: FALLBACK_SHIPPING_COST,
    estimatedNetPerUnit: flaggedDud ? 0 : net,
    flaggedDud,
    marketCheckFailed: false,
  };
}

// ---------------------------------------------------------------------------
// Analyzer Beta pricing inputs (see "Analyzer Beta" above extractText).
// ---------------------------------------------------------------------------

// What Cristian's own eBay sales actually bring in, as a share of the
// manifest retail of the same product: the beta's stand-in for live comps.
// Own sales are his own information, which the license treats separately
// from other sellers' data. Starts out mostly the rule of thumb (8 matched
// sales on 2026-10-18, median 48% of retail) and leans on his real numbers
// as sales add up: each sale counts as one vote against
// RECOVERY_PRIOR_WEIGHT votes for the prior, and a category's own ratio is
// pulled toward the overall one the same way.
const RETAIL_RECOVERY_PRIOR = 0.5;
const RECOVERY_PRIOR_WEIGHT = 10;
// Same share of the blend live comps get in the standard Analyzer (at most
// 10), so the rest of the blend keeps its shape.
const RETAIL_ESTIMATE_WEIGHT = 10;

export type RetailRecovery = { overall: number; sampleSize: number; byCategory: Map<string, number> };

export async function ownRetailRecovery(): Promise<RetailRecovery> {
  const sales = await prisma.ebayItemSale.findMany({
    where: { quantity: { gt: 0 }, item: { isBundle: false, manifestId: { not: null }, upc: { not: null } } },
    select: {
      quantity: true,
      revenue: true,
      soldAt: true,
      item: { select: { upc: true, manifestId: true, isMultipack: true, packSize: true } },
    },
  });
  const pairs = [...new Map(sales.map((s) => [`${s.item.manifestId}|${s.item.upc}`, s.item])).values()];
  const lines =
    pairs.length > 0
      ? await prisma.manifestLine.findMany({
          where: {
            retailPrice: { gt: 0 },
            OR: pairs.map((p) => ({ manifestId: p.manifestId!, upc: p.upc! })),
          },
          select: { manifestId: true, upc: true, retailPrice: true, category: true },
        })
      : [];
  const lineByKey = new Map(lines.map((l) => [`${l.manifestId}|${l.upc}`, l]));

  let total = 0;
  let weight = 0;
  let sampleSize = 0;
  const byCategorySums = new Map<string, { total: number; weight: number }>();
  for (const s of sales) {
    const line = lineByKey.get(`${s.item.manifestId}|${s.item.upc}`);
    if (!line) continue;
    const units = soldPhysicalUnits({ soldQuantity: s.quantity, isMultipack: s.item.isMultipack, packSize: s.item.packSize });
    // Clamped: one mistyped retail shouldn't swing every estimate.
    const ratio = Math.min(3, Math.max(0.05, Number(s.revenue) / units / Number(line.retailPrice)));
    const w = recencyWeight(s.soldAt);
    total += ratio * w;
    weight += w;
    sampleSize++;
    if (line.category) {
      const c = byCategorySums.get(line.category) ?? { total: 0, weight: 0 };
      c.total += ratio * w;
      c.weight += w;
      byCategorySums.set(line.category, c);
    }
  }
  const overall = (total + RETAIL_RECOVERY_PRIOR * RECOVERY_PRIOR_WEIGHT) / (weight + RECOVERY_PRIOR_WEIGHT);
  const byCategory = new Map(
    [...byCategorySums].map(([category, c]) => [
      category,
      (c.total + overall * RECOVERY_PRIOR_WEIGHT) / (c.weight + RECOVERY_PRIOR_WEIGHT),
    ])
  );
  return { overall, sampleSize, byCategory };
}

// Set for a beta evaluation, null for the standard Analyzer. deepResearch:
// the line is in the top MAX_DEEP_RESEARCH_LINES by value, so it gets a web
// price check (the beta's main per-product signal, about $0.04 each).
// savePackDecisions: hand the pack-size call to the scan page (PackDecision).
type BetaPricing = { deepResearch: boolean; recovery: RetailRecovery; savePackDecisions: boolean } | null;

// Other-supplier lines in the beta: the standard path prices them off exact
// eBay listings per box, which the beta can't use, so they're priced like
// any other line but per box as sold (retail and count converted to boxes).
function perBoxGroup(group: LineGroup): LineGroup {
  const perBox = group.boxes > 0 ? Math.max(1, Math.round(group.expectedQuantity / group.boxes)) : 1;
  if (perBox === 1) return { ...group, expectedQuantity: group.boxes };
  return {
    ...group,
    expectedQuantity: group.boxes,
    retailPrice: group.retailPrice * perBox,
    description: `${group.description} (box of ${perBox})`,
  };
}

async function estimateLine(
  group: LineGroup,
  evaluationId: string,
  receiveRate: number,
  runTrendCheck: boolean,
  eventCheckBudget: EventCheckBudget,
  limits: SpeedLimits,
  calibration: Calibration,
  beta: BetaPricing = null
): Promise<LineEstimateResult> {
  const compliant = beta != null;
  // Can't be listed on eBay at all (needles, Rx devices — see ebayBanned),
  // so it's worth $0 whatever the comps say. Skipped before any lookup:
  // live listings exist for some of these and would otherwise price them.
  if (ebayBanReason(group.description)) {
    return {
      upc: group.upc,
      description: group.description,
      extendedRetail: group.extendedRetail,
      estimatedUnitSalePrice: null,
      estimatedUnitFees: null,
      estimatedUnitShipping: null,
      estimatedNetPerUnit: 0,
      effectiveUnits: Math.round(group.expectedQuantity * receiveRate),
      typicalPackSize: 1,
      recommendedPackSize: null,
      recommendedPackBasis: null,
      dataConfidence: "market_only",
      flaggedDud: true,
      marketCheckFailed: false,
      marketTrend: null,
      eventEnded: false,
      postHolidayFiller: false,
      trendNudge: null,
      seasonal: null,
      slowMover: false,
      monthsToSellThrough: null,
    };
  }

  if (group.strictPricing) {
    if (!compliant) return estimateOtherSupplierLine(group, receiveRate, limits, calibration);
    group = perBoxGroup(group);
  }

  // Own-history: exact UPC, across every manifest ever sold, not just this one.
  let ownSalesCount = 0;
  let ownAvgSalePrice = 0;
  let ownAvgShipping = 0;
  let ownFeeRate = FALLBACK_FEE_RATE;
  const ownPackSizes: number[] = [];
  // Physical units of this exact UPC sold within the recent velocity
  // window — see the "Sell-through velocity" section above. Stays 0 (not
  // null) when group.upc is unset; the own-vs-category choice below only
  // looks at ownSalesCount to decide which one actually has real history.
  let ownRecentUnits = 0;
  if (group.upc) {
    // Per-sale rows (EbayItemSale), not the Item-level running totals — the
    // per-sale soldAt is what recencyWeight needs. Item-level totals have
    // no per-sale dates to weight by.
    const sales = await prisma.ebayItemSale.findMany({
      where: { item: { upc: group.upc } },
      select: {
        quantity: true,
        revenue: true,
        fees: true,
        shipping: true,
        soldAt: true,
        item: { select: { isMultipack: true, packSize: true } },
      },
    });
    let rawUnits = 0; // unweighted — still the real-evidence count confidence scoring below relies on
    let weightedUnits = 0;
    let weightedRevenue = 0;
    let weightedFees = 0;
    let weightedShipping = 0;
    for (const s of sales) {
      const u = soldPhysicalUnits({ soldQuantity: s.quantity, isMultipack: s.item.isMultipack, packSize: s.item.packSize });
      const weight = recencyWeight(s.soldAt);
      rawUnits += u;
      weightedUnits += u * weight;
      weightedRevenue += Number(s.revenue) * weight;
      weightedFees += Number(s.fees) * weight;
      weightedShipping += Number(s.shipping) * weight;
      // How this UPC was actually listed when we sold it before — the
      // most reliable signal there is for what a "listing" of it means.
      const packSize = s.item.isMultipack && s.item.packSize ? s.item.packSize : 1;
      for (let n = 0; n < s.quantity; n++) ownPackSizes.push(packSize);
    }
    if (weightedUnits > 0) {
      ownSalesCount = rawUnits;
      ownAvgSalePrice = weightedRevenue / weightedUnits;
      ownAvgShipping = weightedShipping / weightedUnits;
      ownFeeRate = weightedRevenue > 0 ? weightedFees / weightedRevenue : FALLBACK_FEE_RATE;
    }
    ownRecentUnits = recentUnitsSold(sales);
  }

  // Category rollup: other UPCs sharing this manifest line's category,
  // excluding the exact UPC already covered above.
  let categorySalesCount = 0;
  let categoryAvgSalePrice = 0;
  let categoryAvgShipping = 0;
  // Same recent-window velocity signal as ownRecentUnits, used as a proxy
  // when this exact UPC has no history of its own to judge a rate from.
  let categoryRecentUnits = 0;
  if (group.category) {
    const linesInCategory = await prisma.manifestLine.findMany({
      where: { category: group.category, upc: { not: group.upc } },
      select: { upc: true },
      distinct: ["upc"],
    });
    const upcs = linesInCategory.map((l) => l.upc).filter((u): u is string => Boolean(u));
    if (upcs.length > 0) {
      const sales = await prisma.ebayItemSale.findMany({
        where: { item: { upc: { in: upcs } } },
        select: {
          quantity: true,
          revenue: true,
          shipping: true,
          soldAt: true,
          item: { select: { isMultipack: true, packSize: true } },
        },
      });
      let rawUnits = 0;
      let weightedUnits = 0;
      let weightedRevenue = 0;
      let weightedShipping = 0;
      for (const s of sales) {
        const u = soldPhysicalUnits({ soldQuantity: s.quantity, isMultipack: s.item.isMultipack, packSize: s.item.packSize });
        const weight = recencyWeight(s.soldAt);
        rawUnits += u;
        weightedUnits += u * weight;
        weightedRevenue += Number(s.revenue) * weight;
        weightedShipping += Number(s.shipping) * weight;
      }
      if (weightedUnits > 0) {
        categorySalesCount = rawUnits;
        categoryAvgSalePrice = weightedRevenue / weightedUnits;
        categoryAvgShipping = weightedShipping / weightedUnits;
      }
      categoryRecentUnits = recentUnitsSold(sales);
    }
  }

  // Broader real-sales reference — HistoricalSaleRecord, the standalone
  // year-back pull of every real eBay order on the account (see that
  // model's comment). Matched loosely by title text since these rows have
  // no UPC to join on precisely — this is the "have we sold this brand
  // before" signal Cristian asked for when own_history above (exact UPC)
  // comes up empty, which it does for the vast majority of manifest lines
  // since most of a year's real sales predate this app's own tracking or
  // were never scanned through it. Includes the VA's dropshipping sales
  // too (no reliable way to separate them out) — accepted noise, not a bug.
  let historicalSalesCount = 0;
  let historicalAvgSalePrice = 0;
  let historicalAvgShipping = 0;
  let historicalFeeRate = FALLBACK_FEE_RATE;
  const historicalPackSizes: number[] = [];
  const { words: brandMatchWords, firstIsBrand } = extractBrandMatchWords(group.description);
  if (brandMatchWords.length > 0) {
    let historicalMatches = (
      await prisma.historicalSaleRecord.findMany({
        where: { AND: brandMatchWords.map((w) => ({ title: { contains: w, mode: "insensitive" as const } })) },
        select: { title: true, quantity: true, soldPrice: true, shippingCost: true, fees: true, soldAt: true },
        take: 200,
      })
    ).filter((m) => titleHasWords(m.title, brandMatchWords));
    // The strict AND (both leading words) is high-precision but often
    // misses real matches — confirmed live: "Vicks Advanced Soothing
    // Vapors Vaporizer" found nothing against a real "Vicks PURE Zzzs Kidz
    // Liquid Melatonin" historical sale because "Advanced" isn't shared,
    // even though "Vicks" alone is a perfectly good brand signal. Fall
    // back to just the single leading word when the strict match comes up
    // empty, rather than losing the signal entirely.
    // Only when that first word really is the brand (see
    // extractBrandMatchWords).
    if (historicalMatches.length === 0 && firstIsBrand) {
      historicalMatches = (
        await prisma.historicalSaleRecord.findMany({
          where: { title: { contains: brandMatchWords[0], mode: "insensitive" as const } },
          select: { title: true, quantity: true, soldPrice: true, shippingCost: true, fees: true, soldAt: true },
          take: 200,
        })
      ).filter((m) => titleHasWords(m.title, [brandMatchWords[0]]));
    }
    let rawUnits = 0;
    let weightedUnits = 0;
    let weightedRevenue = 0;
    let weightedShipping = 0;
    let weightedFees = 0;
    for (const m of historicalMatches) {
      // Same pack-size normalization as own history / market comps above —
      // a historical record's `quantity` is how many of that (possibly
      // multi-pack) listing were bought, not physical units.
      const packSize = detectPackSize(m.title);
      historicalPackSizes.push(packSize);
      const u = m.quantity * packSize;
      const weight = recencyWeight(m.soldAt);
      rawUnits += u;
      weightedUnits += u * weight;
      weightedRevenue += Number(m.soldPrice) * weight;
      weightedShipping += Number(m.shippingCost) * weight;
      weightedFees += Number(m.fees) * weight;
    }
    if (weightedUnits > 0) {
      historicalSalesCount = rawUnits;
      historicalAvgSalePrice = weightedRevenue / weightedUnits;
      historicalAvgShipping = weightedShipping / weightedUnits;
      historicalFeeRate = weightedRevenue > 0 ? weightedFees / weightedRevenue : FALLBACK_FEE_RATE;
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
  // Distinguishes "we asked eBay and it genuinely has nothing listed" from
  // "we never got an answer" — confirmed live as a real, not theoretical,
  // failure mode: a 40-line manifest of real, sellable L'Oreal Colorsonic
  // cartridges came back 100% flagged as dud because every single comp
  // search hit eBay's Browse API rate limit (429) mid-run, not because the
  // product doesn't sell. With no own-sale or historical-match data either
  // (barely any of the manifest had been scanned in yet), the fallback
  // below would otherwise have no way to tell an API outage apart from a
  // confirmed zero — and confidently called every line a dud on it.
  let marketCheckFailed = false;
  // Per pack size, what live listings go for — feeds the pack-size
  // recommendation, and is kept on the snapshot so the scan page can reuse it.
  let packStats: PackStat[] = [];
  // A real, measured price/listing-volume trend since the last time we
  // actually checked this UPC's live market (see MarketCompSnapshot) — null
  // when there's no prior snapshot to compare against, or when reusing a
  // fresh-enough snapshot below means nothing new was measured this run.
  let marketTrend: string | null = null;
  // Measured later, only for lines that need it (see measureMarketSpeed).
  let sellRate: MarketSellRate | null = null;
  let freshComps: ActiveListingComp[] | null = null;
  let snapshotId: string | null = null;

  // The beta never reads, searches or stores eBay listing data.
  const latestSnapshot =
    group.upc && !compliant
      ? await prisma.marketCompSnapshot.findFirst({ where: { upc: group.upc }, orderBy: { capturedAt: "desc" } })
      : null;
  const snapshotAgeHours = latestSnapshot ? (Date.now() - latestSnapshot.capturedAt.getTime()) / (1000 * 60 * 60) : Infinity;

  if (latestSnapshot && snapshotAgeHours < MARKET_SNAPSHOT_FRESHNESS_HOURS) {
    // Reuse rather than re-ask eBay — this is what was actually burning
    // through the daily Browse API limit: the same UPC getting re-searched
    // from scratch on every evaluation, even re-running the same manifest
    // minutes apart. No per-comp titles are stored in a snapshot, so
    // marketPackSizes stays empty for a reused hit — typicalPackSize still
    // falls back to own/historical pack data when there is any.
    activeCompCount = latestSnapshot.activeCompCount;
    snapshotId = latestSnapshot.id;
    if (latestSnapshot.salesSampled != null) {
      sellRate = { unitsPerMonth: latestSnapshot.listingUnitsPerMonth, sampled: latestSnapshot.salesSampled };
    }
    marketMedian = latestSnapshot.medianPrice != null ? Number(latestSnapshot.medianPrice) : 0;
    packStats = parsePackStats(latestSnapshot.packStats);
  } else if (!compliant) {
    try {
      const comps = await searchActiveListings({ upc: group.upc, keywords: group.description, excludeListingId: null });
      const summary = summarizeComps(comps);
      activeCompCount = summary.activeCompCount;
      freshComps = comps;
      marketMedian = summary.medianPerUnit;
      marketPackSizes.push(...summary.packSizes);
      packStats = summary.packStats;

      if (group.upc) {
        if (latestSnapshot) {
          marketTrend = marketTrendNote(
            { activeCompCount: latestSnapshot.activeCompCount, medianPrice: latestSnapshot.medianPrice != null ? Number(latestSnapshot.medianPrice) : null },
            { activeCompCount, medianPrice: marketMedian },
            snapshotAgeHours / 24
          );
        }
        // Every genuinely fresh check is its own permanent row, never
        // overwritten — that's what turns this into a real time series
        // instead of just a cache (see MarketCompSnapshot).
        const snapshot = await prisma.marketCompSnapshot.create({
          data: {
            upc: group.upc,
            activeCompCount,
            medianPrice: marketMedian > 0 ? marketMedian : null,
            packStats,
          },
        });
        snapshotId = snapshot.id;
      }
    } catch (e) {
      if (!(e instanceof EbayApiError)) throw e;
      console.error(`[sourcingAgent] comp search failed for UPC ${group.upc}`, e);
      marketCheckFailed = true;
    }
  }

  // Live listings' sell speed for this line, saved on its snapshot so a
  // re-run within MARKET_SNAPSHOT_FRESHNESS_HOURS reuses it. A reused
  // snapshot keeps no listing IDs, so that case searches again.
  async function measureMarketSpeed(): Promise<MarketSellRate | null> {
    try {
      const comps =
        freshComps ?? (await searchActiveListings({ upc: group.upc, keywords: group.description, excludeListingId: null }));
      const rate = await marketSellRate(comps);
      if (snapshotId) {
        await prisma.marketCompSnapshot.update({
          where: { id: snapshotId },
          data: { listingUnitsPerMonth: rate.unitsPerMonth, salesSampled: rate.sampled },
        });
      }
      return rate;
    } catch (e) {
      if (!(e instanceof EbayApiError)) throw e;
      console.error(`[sourcingAgent] sell-speed check failed for UPC ${group.upc}`, e);
      return null;
    }
  }

  // Comp and historical prices above are per single unit, but a manifest
  // line can itself be a multi-pack ("Aquaphor ... 0.35 oz x 2 pack") —
  // one of ITS units is that many singles. Own and category history are
  // already per manifest unit (they come from our own scanned items).
  const manifestUnitPackSize = detectPackSize(group.description);
  marketMedian *= manifestUnitPackSize;
  historicalAvgSalePrice *= manifestUnitPackSize;

  // Beta: the manifest's own retail (already per manifest unit) times the
  // share of retail Cristian's own sales recover fills the slot live comps
  // have in the blend below.
  let retailEstimate = 0;
  if (beta && group.retailPrice > 0) {
    retailEstimate =
      group.retailPrice * (group.category ? (beta.recovery.byCategory.get(group.category) ?? beta.recovery.overall) : beta.recovery.overall);
    marketMedian = retailEstimate;
  }

  // Best pack size to sell in — only for a manifest unit that's a single
  // (a line that's already a multi-pack is listed as-is).
  const packRecommendation = manifestUnitPackSize === 1 ? recommendPackSize(packStats, group.retailPrice) : null;

  // What this UPC is realistically LISTED as — own past sales are the most
  // reliable signal when we have them, otherwise the most common pack size
  // seen among live comps. Only matters for amortizing the flat per-listing
  // shipping/fixed-fee fallbacks below correctly (a percentage-of-price fee
  // needs no such adjustment — it already scales with the normalized price).
  const typicalPackSize =
    ownPackSizes.length > 0
      ? modePackSize(ownPackSizes)
      : historicalPackSizes.length > 0
        ? modePackSize(historicalPackSizes)
        : modePackSize(marketPackSizes);

  const effectiveUnits = Math.round(group.expectedQuantity * receiveRate);

  // Confidence-weighted blend — more real samples (capped) = more trust,
  // market signal always contributes some weight since it's always at least
  // directionally available. Historical (fuzzy title-matched, real past
  // orders) sits between own-history (exact UPC) and category rollup —
  // more specific than a whole category, less certain than an exact UPC
  // match.
  const ownScore = Math.min(ownSalesCount, 8) * 3;
  const historicalScore = Math.min(historicalSalesCount, 10) * 2;
  const categoryScore = Math.min(categorySalesCount, 15) * 1.5;
  const marketScore = compliant ? (retailEstimate > 0 ? RETAIL_ESTIMATE_WEIGHT : 0) : Math.min(activeCompCount, 10) * 1;
  const totalScore = ownScore + historicalScore + categoryScore + marketScore;

  // Beta, no retail and no sales of ours: a deep line still gets its web
  // price check below before giving up. Anything left unpriced is an
  // unknown, not a dud: the beta never asked eBay whether it sells.
  // Nothing to go on at all — no comps, no history. Normally that's a
  // fair "can't responsibly estimate, treat as a dud" call. But if the
  // REASON there are no comps is that the market check itself errored
  // (marketCheckFailed) rather than genuinely finding zero listings,
  // that's an unknown, not a confirmed dead item — don't confidently
  // flag it a dud on an API outage (see marketCheckFailed above for the
  // real case this caught live). The beta never checks the market, so its
  // version is always an unknown ("unpriced").
  const nothingToGoOn = async (): Promise<LineEstimateResult> => ({
    upc: group.upc,
    description: group.description,
    extendedRetail: group.extendedRetail,
    estimatedUnitSalePrice: null,
    estimatedUnitFees: null,
    estimatedUnitShipping: null,
    estimatedNetPerUnit: null,
    effectiveUnits,
    typicalPackSize,
    recommendedPackSize: packRecommendation?.packSize ?? null,
    recommendedPackBasis: packRecommendation?.basis ?? null,
    dataConfidence: compliant ? "unpriced" : "market_only",
    flaggedDud: !compliant && !marketCheckFailed,
    marketCheckFailed: compliant || marketCheckFailed,
    marketTrend,
    eventEnded: false,
    postHolidayFiller: isPostHolidayFiller(group.description),
    trendNudge: null,
    seasonal: await seasonalNote(group.category, group.description),
    // ownSalesCount and categorySalesCount are both necessarily 0 here
    // (totalScore === 0), so there's nothing to compute a rate from.
    slowMover: false,
    monthsToSellThrough: null,
  });
  if (totalScore === 0 && !beta?.deepResearch) return nothingToGoOn();

  const preliminaryConfidence: LineEstimateResult["dataConfidence"] =
    ownScore >= historicalScore && ownScore >= categoryScore && ownScore >= marketScore && ownSalesCount >= 3
      ? "own_history"
      : historicalScore >= categoryScore && historicalScore >= marketScore && historicalSalesCount >= 3
        ? "historical_match"
        : categoryScore > marketScore || ownSalesCount > 0 || historicalSalesCount > 0
          ? "category_fallback"
          : compliant
            ? "retail_estimate"
            : "market_only";

  // Only worth spending a web-search call where it can actually change the
  // outcome: a line that would otherwise be priced off nothing more
  // specific than its whole category's average (no real own/historical
  // sales for this exact product) — own_history/historical_match already
  // have real sales backing them, which beats a web-search guess every
  // time, and market_only means the market check itself already came up
  // empty (a web search is unlikely to do better where a direct comp
  // search didn't). Uncapped by design — Cristian's call: check every line
  // that actually needs it, not an arbitrary count.
  // The beta has no comps, so the check is its main per-product signal:
  // every deep line gets one unless our own sales of the UPC already decide
  // it (historical_match is only a brand match, so those get one too).
  const wantsWebCheck = beta
    ? beta.deepResearch && preliminaryConfidence !== "own_history"
    : preliminaryConfidence === "category_fallback";
  const webCheck = wantsWebCheck ? await getWebPriceCheck(group, evaluationId, compliant) : null;
  const rawWebCheckPrice = webCheck?.price ?? null;
  // Same last-resort sanity cap as the market_only path below — a
  // web-search-derived number is still a guess, not a real sale, so it
  // shouldn't be trusted past a implausible multiple of the manifest's own
  // declared retail.
  const webCheckPrice =
    rawWebCheckPrice != null && group.retailPrice > 0
      ? Math.min(rawWebCheckPrice, group.retailPrice * UNVERIFIED_RETAIL_MULTIPLE_CAP)
      : rawWebCheckPrice;
  // A flat weight (not sample-count-scaled like the others — this is one
  // checked answer, not N samples) chosen higher than category's own max
  // (22.5) so a successful check meaningfully outranks the generic category
  // average it's specifically meant to correct, while still leaving room
  // for the market signal to pull the blend a bit either way.
  const WEB_CHECK_WEIGHT = 25;
  const webCheckScore = webCheckPrice != null ? WEB_CHECK_WEIGHT : 0;

  const dataConfidence: LineEstimateResult["dataConfidence"] =
    webCheckScore > 0 ? "web_price_check" : preliminaryConfidence;

  // Shipping/fee blending below intentionally keeps using the original
  // totalScore (no shipping/fee data comes out of a price-only web check) —
  // only the sale-price blend gets the extra webCheckScore term.
  const priceTotalScore = totalScore + webCheckScore;
  if (priceTotalScore === 0) return nothingToGoOn();
  const blendedSalePrice =
    (ownScore * ownAvgSalePrice +
      historicalScore * historicalAvgSalePrice +
      categoryScore * categoryAvgSalePrice +
      marketScore * marketMedian +
      webCheckScore * (webCheckPrice ?? 0)) /
    priceTotalScore;
  // What the prediction tracker learned about how our market-based price
  // guesses compare with what bought loads really sold for. Our own sales
  // history is already real, so it's left alone.
  const calibratedSalePrice = dataConfidence === "own_history" ? blendedSalePrice : blendedSalePrice * calibration.price;
  // Only our own sales of this exact UPC are trusted past the retail cap —
  // everything else (fuzzy historical title matches, a category average,
  // live comps, a web check) can be matching the wrong product or pack
  // size. See UNVERIFIED_RETAIL_MULTIPLE_CAP.
  const estimatedUnitSalePrice =
    dataConfidence !== "own_history" && group.retailPrice > 0
      ? Math.min(calibratedSalePrice, group.retailPrice * UNVERIFIED_RETAIL_MULTIPLE_CAP)
      : calibratedSalePrice;
  // FALLBACK_SHIPPING_COST/FALLBACK_FEE_FIXED are per-LISTING costs (one
  // shipment, one order) — dividing by typicalPackSize amortizes them
  // across the physical units in that listing, same reasoning as
  // normalizing comp prices above. ownAvgShipping needs no such
  // adjustment: it's a real recorded shipping cost already divided by
  // real physical units sold (soldPhysicalUnits), not a flat guess.
  const fallbackShippingPerUnit = FALLBACK_SHIPPING_COST / typicalPackSize;
  const fallbackFeeFixedPerUnit = FALLBACK_FEE_FIXED / typicalPackSize;
  const estimatedUnitShipping =
    ownSalesCount > 0 || historicalSalesCount > 0 || categorySalesCount > 0
      ? (ownScore * ownAvgShipping +
          historicalScore * historicalAvgShipping +
          categoryScore * categoryAvgShipping +
          marketScore * fallbackShippingPerUnit) /
        totalScore
      : fallbackShippingPerUnit;
  // Real fee rate from our own sales when we have it; otherwise the
  // historical pull's real fee rate is still a genuine eBay-charged rate
  // (just for a fuzzily-matched product) and a better guess than the flat
  // fallback constant.
  const feeRate = ownSalesCount > 0 ? ownFeeRate : historicalSalesCount > 0 ? historicalFeeRate : FALLBACK_FEE_RATE;
  const estimatedUnitFees = estimatedUnitSalePrice * feeRate + fallbackFeeFixedPerUnit;
  const rawNet = estimatedUnitSalePrice - estimatedUnitFees - estimatedUnitShipping;

  // Dud: the math is negative. Whether it sells fast enough is the
  // slowMover check below. The old crowded-market rule (lots of listings +
  // no track record = dud, stricter the more stock was on hand) is gone as
  // of 2026-10-16: it dudded popular items like a Manscaped trimmer at
  // ~$47 net/unit, and stock on hand isn't a reason to pass on a product.
  let flaggedDud = rawNet <= 0;

  // Sell-through velocity, best evidence first: our own recent sales of
  // this UPC (the learning part: once we've sold it, our real speed wins),
  // else how fast live eBay listings of it sell (marketSellRate), else the
  // category's own sales as a rough proxy. null = genuinely unknown, not
  // flagged; a real history with zero recent sales is a "stalled" signal.
  // Listings are only checked for a line whose price math already works
  // and that we've never sold ourselves: each listing is an eBay call, and
  // an 855-line manifest checking everything blew the 5,000/day limit.
  let sellRateSource: SellRateSource | null = null;
  let monthsToSellThroughEstimate: number | null = null;
  // Never in the beta: other sellers' sold counts are seller performance
  // data (license 8.1(d)). It goes own sales, then its outside-eBay demand
  // read (web_demand, deep lines only), then category, then none.
  if (!compliant && ownSalesCount === 0 && rawNet > 0 && activeCompCount > 0) {
    sellRate ??= await measureMarketSpeed();
  }
  const marketMonths = monthsAtMarketRate(sellRate, effectiveUnits * manifestUnitPackSize, calibration.speed);
  if (ownSalesCount > 0) {
    sellRateSource = "own";
    monthsToSellThroughEstimate = computeMonthsToSellThrough(ownRecentUnits, effectiveUnits);
  } else if (marketMonths != null) {
    sellRateSource = "ebay_listings";
    monthsToSellThroughEstimate = marketMonths;
  } else if (webCheck?.demand) {
    sellRateSource = "web_demand";
    monthsToSellThroughEstimate = monthsAtDemandTier(webCheck.demand, effectiveUnits, calibration.speed);
  } else if (categorySalesCount > 0) {
    sellRateSource = "category";
    monthsToSellThroughEstimate = computeMonthsToSellThrough(categoryRecentUnits, effectiveUnits);
  }
  const { slowMover, longTail } = await slowSellerTier(monthsToSellThroughEstimate, limits, group.upc, group.description);

  // A good per-unit price doesn't mean much if the expected quantity would
  // sit on the shelf for a year or more — see the "Sell-through velocity"
  // section above (our own sales, else live listings' sold counts).
  if (slowMover) flaggedDud = true;

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
  if (!postHolidayFiller && OCCASION_MERCH_PATTERN.test(group.description)) {
    eventEnded = await isOccasionOutOfSeason(group, evaluationId, eventCheckBudget, compliant);
    if (eventEnded) flaggedDud = true;
  }

  const trendNudge = runTrendCheck ? await getTrendNudge(group, evaluationId, compliant) : null;

  // The pack-size agent (see src/lib/packAdvisor.ts) only for lines worth
  // listing; a dud keeps the free formula answer. Its decision is saved
  // per UPC, so scanning this item in later reuses it instantly.
  const packAdvice =
    manifestUnitPackSize === 1 && !flaggedDud
      ? await advisePackSize({
          upc: group.upc,
          description: group.description,
          retailPrice: group.retailPrice,
          category: group.category,
          packStats,
          evaluationId,
          compliant,
          saveDecision: beta?.savePackDecisions ?? true,
        })
      : packRecommendation;

  return {
    upc: group.upc,
    description: group.description,
    extendedRetail: group.extendedRetail,
    estimatedUnitSalePrice,
    estimatedUnitFees,
    estimatedUnitShipping,
    estimatedNetPerUnit: flaggedDud ? 0 : rawNet,
    effectiveUnits,
    typicalPackSize,
    recommendedPackSize: packAdvice?.packSize ?? null,
    recommendedPackBasis: packAdvice?.basis ?? null,
    dataConfidence,
    flaggedDud,
    slowMover,
    longTail,
    monthsToSellThrough: monthsToSellThroughEstimate,
    sellRateSource,
    listingUnitsPerMonth: sellRate?.unitsPerMonth ?? null,
    marketCheckFailed,
    marketTrend,
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
    // Arrival damage only: units a customer return wrote off weren't the
    // supplier's doing.
    // Beta copies (analyzerBeta) repeat another manifest's lines, so they'd
    // count its units twice.
    prisma.manifestDamagedEntry.aggregate({
      _sum: { quantity: true },
      where: { manifest: { supplier, analyzerBeta: false }, ...NOT_RETURN_ENTRY },
    }),
    prisma.manifestLine.aggregate({ _sum: { expectedQuantity: true }, where: { manifest: { supplier, analyzerBeta: false } } }),
  ]);
  const damagedSum = damaged._sum.quantity ?? 0;
  const expectedSum = expected._sum.expectedQuantity ?? 0;
  if (expectedSum === 0) return 1; // no history yet — no haircut, matches "lean on market signal early" philosophy
  const rate = 1 - damagedSum / expectedSum;
  return Math.max(0.5, Math.min(1, rate));
}

// ---------------------------------------------------------------------------
// Main orchestrator — chunked so a manifest with hundreds of unique UPCs
// (each needing several DB/eBay/Claude round-trips) can't get silently
// killed mid-run by the calling route's maxDuration. Confirmed live: a
// 1036-group manifest got killed by Vercel at the 180s mark with no error,
// leaving its SourcingEvaluation row stuck on "running" forever — nothing
// ever caught that kill to mark it failed, since the whole invocation died,
// not just one call inside it.
//
// Each call processes groups until `deadline`, persisting every finished
// line as its own SourcingLineEstimate row (keyed by groupKey) as it goes —
// not batched at the end — so a resumed call can tell exactly what's left
// by querying which groupKeys already have a row, regardless of which
// invocation did the work. Only once every group has a row does this
// function run the final reasoning/aggregate step and return `done: true`;
// otherwise it returns `done: false` and the caller (the API route) is
// responsible for triggering another invocation.
// ---------------------------------------------------------------------------

const MAX_DEEP_RESEARCH_LINES = 150;
const MAX_TREND_CHECKS = 10;

export type EvaluationChunkResult =
  | {
      done: true;
      recommendation: "buy" | "dont_buy";
      maxBid: number;
      expectedNetContribution: number;
      dudShare: number;
      concentrationRisk: boolean;
      reasoning: string;
    }
  // budgetResetsAt: stopped because eBay's daily Browse limit is nearly
  // used up (see BROWSE_CALLS_RESERVE); finish after it resets.
  | { done: false; processedSteps: number; totalSteps: number; budgetResetsAt?: Date };

// Browse calls (searches + listing lookups, 5,000/day) left alone for the
// scan page's pack card and the review page's price research. A big
// manifest stops at this point instead of running eBay dry, and failed
// lookups would otherwise get saved as real "no data" answers.
const BROWSE_CALLS_RESERVE = 400;
// Re-check the remaining count after this many lines (a line uses up to
// ~11 calls, 5 run at once).
const BUDGET_CHECK_EVERY_LINES = 10;

export async function evaluateManifestChunk(
  evaluationId: string,
  manifestId: string,
  deadline: number,
  onProgress?: (processedSteps: number, totalSteps: number) => void
): Promise<EvaluationChunkResult> {
  const evaluation = await prisma.sourcingEvaluation.findUniqueOrThrow({ where: { id: evaluationId } });
  const manifest = await prisma.manifest.findUniqueOrThrow({
    where: { id: manifestId },
    include: { lines: true },
  });

  // Settings that must stay identical across every chunk of the same
  // evaluation (see the SourcingEvaluation schema comment) — computed once,
  // on whichever call happens to be first, then reused by every later one
  // instead of re-reading live state that may have drifted since (a sale
  // landing between chunks, say, would otherwise shift a line's sell speed
  // partway through the same evaluation).
  let targetMarginPct: number;
  let receiveRate: number;
  let maxMonthsToSellThrough: number;
  let longTailMonths: number;
  let unprovenMarginPct: number;
  let calibration: Calibration;
  if (evaluation.targetMarginPct != null) {
    targetMarginPct = evaluation.targetMarginPct;
    receiveRate = evaluation.receiveRate!;
    maxMonthsToSellThrough = evaluation.maxMonthsToSellThrough!;
    // Evaluations started before these existed resume with the defaults.
    longTailMonths = evaluation.longTailMonths ?? maxMonthsToSellThrough;
    unprovenMarginPct = evaluation.unprovenMarginPct ?? targetMarginPct;
    calibration = { price: evaluation.priceCalibration ?? 1, speed: evaluation.speedCalibration ?? 1 };
  } else {
    targetMarginPct = await getTargetMarginPct();
    receiveRate = await getSupplierReceiveRate(manifest.supplier);
    maxMonthsToSellThrough = await getMaxMonthsToSellThrough();
    longTailMonths = Math.max(maxMonthsToSellThrough, await getLongTailMonths());
    unprovenMarginPct = Math.max(targetMarginPct, await getUnprovenMarginPct());
    // Each Analyzer learns its own corrections (see predictionTracker.ts).
    calibration = await getCalibration(evaluation.engine === "compliant" ? "compliant" : "legacy");
    await prisma.sourcingEvaluation.update({
      where: { id: evaluationId },
      data: {
        targetMarginPct,
        receiveRate,
        maxMonthsToSellThrough,
        unprovenMarginPct,
        longTailMonths,
        priceCalibration: calibration.price,
        speedCalibration: calibration.speed,
      },
    });
  }

  // Group lines by UPC (duplicates collapse into one group) — a liquidation
  // manifest's line count usually collapses to far fewer unique UPCs.
  const groups = new Map<string, LineGroup>();
  for (const line of manifest.lines) {
    const key = line.upc ?? `__no_upc_${line.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.expectedQuantity += line.expectedQuantity;
      existing.extendedRetail += Number(line.extendedRetail);
      // Boxes per line, then summed: the same UPC can come in different
      // case packs on different lines.
      existing.boxes += boxesFor(line.expectedQuantity, line.piecesPerBox, line.description);
      existing.piecesPerBox ??= line.piecesPerBox;
    } else {
      groups.set(key, {
        groupKey: key,
        upc: line.upc,
        description: line.description,
        category: line.category,
        expectedQuantity: line.expectedQuantity,
        extendedRetail: Number(line.extendedRetail),
        retailPrice: Number(line.retailPrice),
        strictPricing: manifest.supplier === "unknown",
        supplierSku: line.supplierSku,
        piecesPerBox: line.piecesPerBox,
        boxes: boxesFor(line.expectedQuantity, line.piecesPerBox, line.description),
      });
    }
  }

  // Deep-research the top N by value; everything past that still counts
  // toward the total (via a cheap category/market-only pass, no per-line
  // trend check) so a huge manifest's economics aren't silently dropped.
  // Ties (every line, on a manifest with no retail prices) go to the
  // bigger quantity, so the cap drops the smallest lines, not arbitrary ones.
  const sortedGroups = [...groups.values()].sort(
    (a, b) => b.extendedRetail - a.extendedRetail || b.expectedQuantity - a.expectedQuantity
  );
  const deepGroups = sortedGroups.slice(0, MAX_DEEP_RESEARCH_LINES);
  const shallowGroups = sortedGroups.slice(MAX_DEEP_RESEARCH_LINES);
  const deepIndexByKey = new Map(deepGroups.map((g, i) => [g.groupKey, i]));

  // +1 for the final reasoning call below, so the bar doesn't sit at 100%
  // while that (often multi-second) LLM call is still running.
  const totalSteps = sortedGroups.length + 1;

  const doneRows = await prisma.sourcingLineEstimate.findMany({
    where: { evaluationId, groupKey: { not: null } },
    select: { groupKey: true },
  });
  const doneKeys = new Set(doneRows.map((r) => r.groupKey!));
  const locallyDone = new Set<string>();
  let processedSteps = doneKeys.size;
  const reportProgress = () => onProgress?.(processedSteps, totalSteps);
  reportProgress();

  const remainingDeep = deepGroups.filter((g) => !doneKeys.has(g.groupKey));
  const remainingShallow = shallowGroups.filter((g) => !doneKeys.has(g.groupKey));

  // The live Analyzer is priced inside eBay's API License (see BetaPricing);
  // "legacy" is the original comps-based one, run only on request.
  const compliant = evaluation.engine === "compliant";
  const recovery = compliant ? await ownRetailRecovery() : null;
  // The new Analyzer's pack calls go to the scan page like the old one's
  // did (Cristian's 2026-09-27 ask), except from comparison copies.
  const savePackDecisions = compliant && !manifest.analyzerBeta;

  let budgetResetsAt: Date | null = null;
  async function checkBrowseBudget() {
    if (compliant) return; // no Browse calls to budget for
    const budget = await getBrowseCallsRemaining().catch(() => null);
    if (budget && budget.remaining < BROWSE_CALLS_RESERVE) budgetResetsAt = budget.resetsAt;
  }
  await checkBrowseBudget();
  let linesSinceBudgetCheck = 0;
  const pastDeadline = () => Date.now() > deadline || budgetResetsAt != null;

  const eventCheckBudget: EventCheckBudget = {
    remaining: Math.max(0, MAX_EVENT_CHECKS - evaluation.eventChecksUsed),
    used: 0,
  };

  async function runAndPersist(group: LineGroup): Promise<void> {
    const deepIndex = deepIndexByKey.get(group.groupKey);
    const runTrendCheck = deepIndex != null && deepIndex < MAX_TREND_CHECKS;
    const result = await estimateLine(
      group,
      evaluationId,
      receiveRate,
      runTrendCheck,
      eventCheckBudget,
      { fullValueMonths: maxMonthsToSellThrough, longTailMonths },
      calibration,
      recovery ? { deepResearch: deepIndex != null, recovery, savePackDecisions } : null
    );
    await prisma.sourcingLineEstimate.create({
      data: {
        evaluationId,
        groupKey: group.groupKey,
        upc: result.upc,
        description: result.description,
        extendedRetail: result.extendedRetail,
        estimatedUnitSalePrice: result.estimatedUnitSalePrice,
        estimatedUnitFees: result.estimatedUnitFees,
        estimatedUnitShipping: result.estimatedUnitShipping,
        estimatedNetPerUnit: result.estimatedNetPerUnit,
        effectiveUnits: result.effectiveUnits,
        typicalPackSize: result.typicalPackSize,
        recommendedPackSize: result.recommendedPackSize,
        recommendedPackBasis: result.recommendedPackBasis,
        dataConfidence: result.dataConfidence,
        flaggedDud: result.flaggedDud,
        slowMover: result.slowMover,
        longTail: result.longTail ?? false,
        monthsToSellThrough: result.monthsToSellThrough,
        sellRateSource: result.sellRateSource ?? null,
        listingUnitsPerMonth: result.listingUnitsPerMonth ?? null,
        marketCheckFailed: result.marketCheckFailed,
        marketTrend: result.marketTrend,
        eventEnded: result.eventEnded,
        postHolidayFiller: result.postHolidayFiller,
        trendNudge: result.trendNudge,
        seasonal: result.seasonal,
      },
    });
    locallyDone.add(group.groupKey);
    processedSteps++;
    reportProgress();
    if (++linesSinceBudgetCheck >= BUDGET_CHECK_EVERY_LINES) {
      linesSinceBudgetCheck = 0;
      await checkBrowseBudget();
    }
  }

  await mapWithConcurrency(remainingDeep, 5, runAndPersist, pastDeadline);

  const deepDone = deepGroups.every((g) => doneKeys.has(g.groupKey) || locallyDone.has(g.groupKey));
  // Only move on to the shallow (lower-value) pass once every deep group is
  // actually done — if the deadline cut deep research short, the next chunk
  // should pick up the rest of THAT first, not skip ahead to cheaper lines.
  if (deepDone && !pastDeadline()) {
    await mapWithConcurrency(remainingShallow, 5, runAndPersist, pastDeadline);
  }

  if (eventCheckBudget.used > 0) {
    await prisma.sourcingEvaluation
      .update({ where: { id: evaluationId }, data: { eventChecksUsed: { increment: eventCheckBudget.used } } })
      .catch((e) => console.error(`[sourcingAgent] eventChecksUsed update failed for evaluation ${evaluationId}`, e));
  }

  const allDone = sortedGroups.every((g) => doneKeys.has(g.groupKey) || locallyDone.has(g.groupKey));
  if (!allDone) {
    return { done: false, processedSteps, totalSteps, budgetResetsAt: budgetResetsAt ?? undefined };
  }

  // ---------------------------------------------------------------------
  // Finalization — only reached once every group has a persisted row.
  // Re-read from the DB rather than trusting in-memory results, since some
  // (or all) of those rows may have been written by an earlier chunk.
  // ---------------------------------------------------------------------
  const allRows = await prisma.sourcingLineEstimate.findMany({ where: { evaluationId } });
  const rowsByKey = new Map(allRows.map((r) => [r.groupKey, r]));
  const lineEstimates: LineEstimateResult[] = sortedGroups.map((g) => {
    const row = rowsByKey.get(g.groupKey);
    if (!row) throw new Error(`Missing SourcingLineEstimate row for groupKey ${g.groupKey} after all-done check.`);
    return {
      upc: row.upc,
      description: row.description,
      extendedRetail: Number(row.extendedRetail),
      estimatedUnitSalePrice: row.estimatedUnitSalePrice != null ? Number(row.estimatedUnitSalePrice) : null,
      estimatedUnitFees: row.estimatedUnitFees != null ? Number(row.estimatedUnitFees) : null,
      estimatedUnitShipping: row.estimatedUnitShipping != null ? Number(row.estimatedUnitShipping) : null,
      estimatedNetPerUnit: row.estimatedNetPerUnit != null ? Number(row.estimatedNetPerUnit) : null,
      effectiveUnits: row.effectiveUnits,
      typicalPackSize: row.typicalPackSize,
      recommendedPackSize: row.recommendedPackSize,
      recommendedPackBasis: row.recommendedPackBasis as LineEstimateResult["recommendedPackBasis"],
      dataConfidence: row.dataConfidence as LineEstimateResult["dataConfidence"],
      flaggedDud: row.flaggedDud,
      slowMover: row.slowMover,
      longTail: row.longTail,
      monthsToSellThrough: row.monthsToSellThrough,
      sellRateSource: row.sellRateSource as LineEstimateResult["sellRateSource"],
      listingUnitsPerMonth: row.listingUnitsPerMonth,
      marketCheckFailed: row.marketCheckFailed,
      marketTrend: row.marketTrend,
      eventEnded: row.eventEnded,
      postHolidayFiller: row.postHolidayFiller,
      trendNudge: row.trendNudge,
      seasonal: row.seasonal,
    };
  });

  // Lines with no sell-speed evidence of any kind still count, but they're
  // bid at the (higher) unproven margin, so they're only bought cheap.
  // Rows from before sellRateSource existed all read null, but those
  // evaluations never reach this point again.
  const isUnproven = (est: LineEstimateResult) => !est.flaggedDud && (est.sellRateSource ?? null) === null;
  // Same cheap margin for slow-but-kept stock (see slowSellerTier).
  const isCheap = (est: LineEstimateResult) => isUnproven(est) || Boolean(est.longTail);
  let totalExpectedNetContribution = 0;
  let unprovenNetContribution = 0;
  for (const est of lineEstimates) {
    const net = (est.estimatedNetPerUnit ?? 0) * est.effectiveUnits;
    totalExpectedNetContribution += net;
    if (isCheap(est)) unprovenNetContribution += net;
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

  const maxBid = Math.max(
    0,
    (totalExpectedNetContribution - unprovenNetContribution) / (1 + targetMarginPct / 100) +
      unprovenNetContribution / (1 + unprovenMarginPct / 100)
  );

  // Buy/Don't-Buy is code-computed and deterministic — the LLM only
  // explains it afterward, never re-decides it, so the call stays
  // reproducible instead of depending on model sampling.
  const recommendation: "buy" | "dont_buy" =
    maxBid >= MIN_BID_FLOOR && dudShare < 0.6 && !concentrationRisk ? "buy" : "dont_buy";

  const knowledgeScopes = [
    `supplier:${manifest.supplier}`,
    ACCURACY_KNOWLEDGE_SCOPE,
    ...new Set(sortedGroups.map((g) => g.category).filter((c): c is string => Boolean(c)).map((c) => `category:${c}`)),
  ].slice(0, 10);
  const knowledgeNotes = await prisma.sourcingKnowledge.findMany({ where: { scope: { in: knowledgeScopes } } });

  const reasoning = await writeReasoning({
    evaluationId,
    retailRecovery: recovery,
    manifestTitle: manifest.title,
    supplier: manifest.supplier,
    consignmentSupplierPct: manifest.consignment ? (manifest.consignmentSupplierPct ?? 50) : null,
    targetMarginPct,
    receiveRate,
    totalExpectedNetContribution,
    unprovenNetContribution,
    unprovenMarginPct,
    unprovenLines: lineEstimates
      .filter((e) => isCheap(e) && (e.estimatedNetPerUnit ?? 0) > 0)
      .sort((a, b) => (b.estimatedNetPerUnit ?? 0) * b.effectiveUnits - (a.estimatedNetPerUnit ?? 0) * a.effectiveUnits)
      .slice(0, 5)
      .map(
        (e) =>
          `- ${e.description}: ${e.effectiveUnits} units, est. $${((e.estimatedNetPerUnit ?? 0) * e.effectiveUnits).toFixed(0)} net, ${
            e.longTail ? `slow (~${e.monthsToSellThrough?.toFixed(0)} months to sell through, doesn't expire)` : "no sell-speed evidence"
          }`
      ),
    calibration,
    maxBid,
    recommendation,
    dudShare,
    concentrationRisk,
    topLines: lineEstimates
      .slice()
      .sort((a, b) => (b.estimatedNetPerUnit ?? 0) * b.effectiveUnits - (a.estimatedNetPerUnit ?? 0) * a.effectiveUnits)
      .slice(0, 8),
    dudLines: lineEstimates.filter((e) => e.flaggedDud && !ebayBanReason(e.description)).slice(0, 5),
    bannedLines: lineEstimates
      .filter((e) => ebayBanReason(e.description))
      .map((e) => `- ${e.description} (${e.effectiveUnits} units): ${ebayBanReason(e.description)}`)
      .slice(0, 10),
    bannedLineCount: lineEstimates.filter((e) => ebayBanReason(e.description)).length,
    marketDataUnavailableCount: lineEstimates.filter((e) => e.marketCheckFailed).length,
    expiredEventLines: lineEstimates
      .filter((e) => e.eventEnded)
      .map((e) => `- ${e.description}`)
      .slice(0, 10),
    postHolidayLines: lineEstimates
      .filter((e) => e.postHolidayFiller)
      .map((e) => `- ${e.description}`)
      .slice(0, 10),
    slowMoverLines: lineEstimates
      .filter((e) => e.slowMover)
      .map(
        (e) =>
          `- ${e.description}: ${e.effectiveUnits} units expected, recent sell rate implies ${
            e.monthsToSellThrough != null && e.monthsToSellThrough < STALLED_MONTHS_SENTINEL
              ? `~${e.monthsToSellThrough.toFixed(1)} months to sell through`
              : e.sellRateSource === "ebay_listings"
                ? "live eBay listings of it show essentially no sales"
                : e.sellRateSource === "web_demand"
                  ? "demand signals outside eBay show essentially no one buying it"
                  : "no recent sales at all despite real history — effectively stalled"
          } (${SELL_RATE_SOURCE_LABELS[e.sellRateSource ?? "own"]})`
      )
      .slice(0, 10),
    knowledgeNotes: knowledgeNotes.map((n) => `[${n.scope}] ${n.notes}`),
    seasonalNotes: [...new Set(lineEstimates.map((e) => e.seasonal).filter((s): s is string => Boolean(s)))].slice(0, 3),
    trendNudges: lineEstimates
      .filter((e) => e.trendNudge)
      .map((e) => `${e.description}: ${e.trendNudge}`)
      .slice(0, MAX_TREND_CHECKS),
    marketTrends: lineEstimates
      .filter((e) => e.marketTrend)
      .map((e) => `${e.description}: ${e.marketTrend}`)
      .slice(0, 10),
  });

  processedSteps++;
  reportProgress();

  return {
    done: true,
    recommendation,
    maxBid,
    expectedNetContribution: totalExpectedNetContribution,
    dudShare,
    concentrationRisk,
    reasoning,
  };
}

// Void-returning rather than collecting results — every result is persisted
// to the DB by `fn` itself as it completes (see runAndPersist above), not
// gathered into an array, since a chunk deliberately doesn't wait for every
// item to finish. `shouldStop` is checked before each new item is started
// (never mid-item, so an in-flight network call always finishes cleanly) —
// once true, in-flight items still run to completion but no new ones start.
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      if (shouldStop()) return;
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

const SELL_RATE_SOURCE_LABELS = {
  own: "based on our own recent sales",
  ebay_listings: "based on how fast other sellers' live listings of it sell",
  web_demand: "based on demand signals outside eBay, like Amazon sales",
  category: "based on our sales of similar items",
} as const;

async function writeReasoning(input: {
  evaluationId: string;
  // Set for an Analyzer Beta run, which never looked at eBay listings.
  retailRecovery: RetailRecovery | null;
  manifestTitle: string;
  // Set for a consignment load (src/lib/consignment.ts): no bid at all.
  consignmentSupplierPct: number | null;
  supplier: string;
  targetMarginPct: number;
  receiveRate: number;
  totalExpectedNetContribution: number;
  unprovenNetContribution: number;
  unprovenMarginPct: number;
  unprovenLines: string[];
  calibration: Calibration;
  maxBid: number;
  recommendation: "buy" | "dont_buy";
  dudShare: number;
  concentrationRisk: boolean;
  topLines: LineEstimateResult[];
  dudLines: LineEstimateResult[];
  bannedLines: string[];
  bannedLineCount: number;
  marketDataUnavailableCount: number;
  expiredEventLines: string[];
  postHolidayLines: string[];
  slowMoverLines: string[];
  knowledgeNotes: string[];
  seasonalNotes: string[];
  trendNudges: string[];
  marketTrends: string[];
}): Promise<string> {
  const beta = input.retailRecovery;
  const prompt = `You are explaining a liquidation manifest sourcing decision that has ALREADY been computed. Do not redo the math or change the call — just write a clear, plain-language explanation a busy reseller can read in 10 seconds and trust.
${
  beta
    ? `
How prices were estimated: from our own past sales, the manifest's retail price times the share of retail our own sales actually bring in (currently ${(beta.overall * 100).toFixed(0)}%, from ${beta.sampleSize} matched sale${beta.sampleSize === 1 ? "" : "s"} of ours, leaning on a 50% rule of thumb until there are more), and web research of store prices for the most valuable items. It does not look at other sellers' eBay listings, prices or sales at all, so never mention live comps, eBay listings or eBay demand. Sell speed comes from our own sales, or, for the most valuable items, a read of demand outside eBay (Amazon "bought in past month", sales rank, reviews), else our sales of similar items.
`
    : ""
}
Manifest: "${input.manifestTitle}" from ${input.supplier}
${
  input.consignmentSupplierPct != null
    ? `THIS LOAD IS ON CONSIGNMENT: there is no bid and no upfront cost. The owner picks which items to take, pays the supplier ${input.consignmentSupplierPct}% of the profit after eBay fees and the shipping label only when something sells, and can return whatever doesn't sell. Ignore the buy/bid framing in the numbers below: instead, explain which kinds of items are worth taking, which to leave behind and why, and that slow sellers are worth taking only in the amount that sells within the time limits (the rest stays with the supplier). The app shows the exact pick list separately, so don't list quantities.`
    : `Call: ${input.recommendation.toUpperCase().replace("_", " ")}
Max recommended bid: $${input.maxBid.toFixed(2)}`
}
Expected net contribution before bid cost: $${input.totalExpectedNetContribution.toFixed(2)}
Target margin used: ${input.targetMarginPct}%
Expected net from lines bid cheap: $${input.unprovenNetContribution.toFixed(2)}. Two kinds: lines with NO sell-speed evidence at all (${beta ? "never sold by us, no similar sales of ours" : "never sold by us, too few live listings to measure, no similar sales"}), and non-expiring lines that sell too slowly for full value but within a year. The owner is growing by reinvesting profit into more inventory and is fine holding slow, non-expiring stock, but only when it's cheap, since fast sellers free up cash sooner. These were bid at a ${input.unprovenMarginPct}% margin instead. Describe the slow ones as bonus profit the buy doesn't depend on: the fast sellers are what pay for the load.${input.unprovenLines.length > 0 ? ` Biggest ones:\n${input.unprovenLines.join("\n")}` : ""}
Learned corrections from past bought loads (actual vs guessed, 1.00 = none yet): price ${input.calibration.price.toFixed(2)}, sell speed ${input.calibration.speed.toFixed(2)}.
Supplier's real historical receive rate (after damage/expired): ${(input.receiveRate * 100).toFixed(0)}%
Share of lines flagged as likely duds: ${(input.dudShare * 100).toFixed(0)}%
Concentration risk flagged: ${input.concentrationRisk ? "yes — one item dominates the manifest's value and looks weak" : "no"}

Top contributing lines:
${input.topLines.map((l) => `- ${l.description} (UPC ${l.upc ?? "n/a"}): est. $${l.estimatedNetPerUnit?.toFixed(2) ?? "?"} net/unit × ${l.effectiveUnits} units, confidence: ${l.dataConfidence}`).join("\n") || "none"}

Lines flagged as likely duds:
${input.dudLines.map((l) => `- ${l.description} (UPC ${l.upc ?? "n/a"})`).join("\n") || "none"}

Lines eBay doesn't allow listing at all (needles, prescription devices, COVID tests), valued at $0 and counted as duds (${input.bannedLineCount} total${input.bannedLineCount > 10 ? ", first 10 shown" : ""}):
${input.bannedLines.join("\n") || "none"}

${
  beta
    ? `Lines we couldn't price at all (no retail price on the manifest, no sales of ours, no web research for them): ${input.marketDataUnavailableCount}${input.marketDataUnavailableCount > 0 ? " — NOT counted as duds, just unpriced. Mention this as a real caveat, don't imply these items don't sell." : ""}`
    : `Lines where live eBay market data couldn't be checked at all right now (API outage/rate limit, not a confirmed lack of demand — NOT counted as duds, but genuinely unpriced): ${input.marketDataUnavailableCount}${input.marketDataUnavailableCount > 0 ? " — mention this as a real caveat (worth a re-run later for a fuller read), don't imply these items don't sell." : ""}`
}

Lines flagged as licensed merch for an event that has already concluded (treated as dead stock regardless of live comps):
${input.expiredEventLines.join("\n") || "none"}

Lines flagged as recurring-holiday filler found outside its real sell window (e.g. Christmas ornaments in spring, Halloween decor outside Aug-Oct) — treated as dead stock:
${input.postHolidayLines.join("\n") || "none"}

Lines flagged as slow movers — a real, measured sell-through rate for this UPC (or its category, as a proxy) says the expected quantity would take too long to clear, regardless of the per-unit margin looking fine:
${input.slowMoverLines.join("\n") || "none"}

Accumulated notes from past manifests:
${input.knowledgeNotes.join("\n") || "none yet"}

Seasonal signals:
${input.seasonalNotes.join("\n") || "none notable"}

Trend signals (directional only, from live web search):
${input.trendNudges.join("\n") || "none notable"}
${
  beta
    ? ""
    : `
Real measured market movement since we last checked these UPCs ourselves (our own repeated live comp checks over time — more reliable than the web-search signal above, since it's an actual price change we observed, not an LLM's read of outside chatter):
${input.marketTrends.join("\n") || "none notable — either no prior check to compare against yet, or nothing moved enough to be worth mentioning"}
`
}
Write 3-6 sentences: which items drove the call, any supplier/category patterns applied, seasonal timing if relevant, any trend signal factored in (the measured market movement above and the web-search trend signal are different kinds of evidence — don't conflate them if both are mentioned). Never cite how much stock we already have on hand as a reason; the call is about whether these items sell. If any lines are ones eBay doesn't allow, say so plainly as its own reason (they can't be sold on eBay at any price, which is different from a weak market). If any slow movers were flagged, mention that plainly too — it's a different kind of caution from a plain margin/dud problem (a genuinely slow seller, not necessarily an unprofitable one) and worth calling out as its own reason, not lumped in with the other dud reasons. Plain language, no bullet points, no restating the raw numbers verbatim.`;

  try {
    const response = await anthropic.messages.create(
      // 600 cut every explanation off mid-sentence (2026-10-18: all 8 latest
      // hit exactly 600 output tokens with ~150 words of text): the model
      // spends part of the budget thinking before it writes.
      { model: "claude-opus-5-5", max_tokens: 3000, messages: [{ role: "user", content: prompt }] },
      { timeout: 45_000, maxRetries: 0 }
    );
    await logAiUsage("sourcing.reasoning", response, { evaluationId: input.evaluationId });
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
    await logAiUsage("sourcing.knowledge_update", response);
    const updated = extractText(response.content).trim();
    await prisma.sourcingKnowledge.update({ where: { scope }, data: { notes: updated || newFacts } });
  } catch (e) {
    console.error(`[sourcingAgent] updateScopeKnowledge failed for ${scope}`, e);
  }
}
