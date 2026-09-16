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
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
        messages: [
          {
            role: "user",
            content: `Is "${description}" currently seeing any notable spike or dropoff in search/social interest or demand? Answer in one short sentence, plainly stating up, down, or no notable signal. If you can't find anything meaningful, just say "No notable signal."`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock && "text" in textBlock ? textBlock.text.trim() : null;
    if (!text || /no notable signal/i.test(text)) return null;
    return text;
  } catch (e) {
    console.error(`[sourcingAgent] trend nudge failed for "${description}"`, e);
    return null;
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
  dataConfidence: "own_history" | "category_fallback" | "market_only";
  flaggedDud: boolean;
  trendNudge: string | null;
  seasonal: string | null;
};

async function estimateLine(
  group: LineGroup,
  receiveRate: number,
  runTrendCheck: boolean
): Promise<LineEstimateResult> {
  // Own-history: exact UPC, across every manifest ever sold, not just this one.
  let ownSalesCount = 0;
  let ownAvgSalePrice = 0;
  let ownAvgShipping = 0;
  let ownFeeRate = FALLBACK_FEE_RATE;
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
  let marketMedian = 0;
  let activeCompCount = 0;
  try {
    const comps = await searchActiveListings({ upc: group.upc, keywords: group.description, excludeListingId: null });
    activeCompCount = comps.length;
    if (comps.length > 0) {
      const totals = comps.map((c) => c.totalPrice).sort((a, b) => a - b);
      const mid = Math.floor(totals.length / 2);
      marketMedian = totals.length % 2 === 0 ? (totals[mid - 1] + totals[mid]) / 2 : totals[mid];
    }
  } catch (e) {
    if (!(e instanceof EbayApiError)) throw e;
    console.error(`[sourcingAgent] comp search failed for UPC ${group.upc}`, e);
  }

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
      dataConfidence: "market_only",
      flaggedDud: true,
      trendNudge: null,
      seasonal: await seasonalNote(group.category, group.description),
    };
  }

  const estimatedUnitSalePrice =
    (ownScore * ownAvgSalePrice + categoryScore * categoryAvgSalePrice + marketScore * marketMedian) / totalScore;
  const estimatedUnitShipping =
    ownSalesCount > 0 || categorySalesCount > 0
      ? (ownScore * ownAvgShipping + categoryScore * categoryAvgShipping + marketScore * FALLBACK_SHIPPING_COST) / totalScore
      : FALLBACK_SHIPPING_COST;
  const estimatedUnitFees = estimatedUnitSalePrice * ownFeeRate + FALLBACK_FEE_FIXED;
  const rawNet = estimatedUnitSalePrice - estimatedUnitFees - estimatedUnitShipping;

  // Dud: heavily saturated market (lots of active comps) with no real sales
  // history to back up that it actually moves, or the math is just negative.
  const flaggedDud = rawNet <= 0 || (ownSalesCount === 0 && categorySalesCount === 0 && activeCompCount >= 15);

  const dataConfidence: LineEstimateResult["dataConfidence"] =
    ownScore >= categoryScore && ownScore >= marketScore && ownSalesCount >= 3
      ? "own_history"
      : categoryScore > marketScore || ownSalesCount > 0
        ? "category_fallback"
        : "market_only";

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
    dataConfidence,
    flaggedDud,
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

  const deepEstimates = await mapWithConcurrency(deepGroups, 5, async (group, index) =>
    estimateLine(group, receiveRate, index < MAX_TREND_CHECKS)
  );
  const shallowEstimates = await mapWithConcurrency(shallowGroups, 5, (group) => estimateLine(group, receiveRate, false));

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
    knowledgeNotes: knowledgeNotes.map((n) => `[${n.scope}] ${n.notes}`),
    seasonalNotes: [...new Set(lineEstimates.map((e) => e.seasonal).filter((s): s is string => Boolean(s)))].slice(0, 3),
    trendNudges: lineEstimates
      .filter((e) => e.trendNudge)
      .map((e) => `${e.description}: ${e.trendNudge}`)
      .slice(0, MAX_TREND_CHECKS),
  });

  return { recommendation, maxBid, reasoning, lineEstimates };
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
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock && "text" in textBlock ? textBlock.text.trim() : "Reasoning unavailable.";
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
    const textBlock = response.content.find((b) => b.type === "text");
    const updated = textBlock && "text" in textBlock ? textBlock.text.trim() : null;
    await prisma.sourcingKnowledge.update({ where: { scope }, data: { notes: updated || newFacts } });
  } catch (e) {
    console.error(`[sourcingAgent] updateScopeKnowledge failed for ${scope}`, e);
  }
}
