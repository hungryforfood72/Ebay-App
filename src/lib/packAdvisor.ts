import { EBAY_DATA_DOMAINS } from "./ebayDataDomains";
import { prisma } from "./prisma";
import { anthropic } from "./anthropic";
import { logAiUsage } from "./aiUsage";
import {
  FALLBACK_FEE_FIXED,
  FALLBACK_FEE_RATE,
  MAX_RECOMMENDED_PACK,
  PACKAGING_OZ,
  SHIPPING_PER_EXTRA_UNIT,
  recommendPackSize,
  type PackStat,
} from "./packSize";
import { typicalSingleLabelCost } from "./shippingCost";
import { labelForWeight } from "./shippingZone";

// ---------------------------------------------------------------------------
// Pack-size agent — decides whether a product should be listed as singles
// or in multi-packs, and says why in a sentence the person scanning reads.
//
// Replaced a pure formula (most net profit per unit) on 2026-09-27 after
// Cristian caught it telling Lizvet to sell Banana Boat tanning oil as
// singles: singles did net more per can, but on eBay nobody pays $17 for a
// can they can buy at the store for $15, while a $19.99 3-pack had sold 31
// times. His goal is selling stock through quickly at a profit, not the
// top dollar per unit, and he wanted the agent to reason like he did (and
// keep learning from his corrections), not follow a new hardcoded rule.
// Code still does the arithmetic; the model weighs it. recommendPackSize
// is the fallback when the model call fails.
// ---------------------------------------------------------------------------

export const PACK_STRATEGY_SCOPE = "pack_strategy";
// Long enough to cover the gap between running the Analyzer before a bid
// and the pallet actually arriving to be scanned, so Lizvet's scan reuses
// the Analyzer's call instead of paying for a new one (Cristian's ask,
// 2026-09-27). Any new correction from Cristian still invalidates it.
const DECISION_REUSE_DAYS = 30;
// Calls made before the agent priced shipping by weight (it assumed $5 plus
// $0.75 per extra unit, which undervalued bigger packs of light items) are
// re-decided once, Cristian's call 2026-10-15.
const REAL_SHIPPING_SINCE = new Date("2026-10-15T17:15:00Z");
const FEEDBACK_EXAMPLES = 8;
// The learning pass re-summarizes sell-speed data at most this often when
// there's no new correction from Cristian, so the lessons (and every
// cached decision, which a lessons change invalidates) don't churn every
// 4 hours on routine sales.
const LESSONS_REFRESH_DAYS = 7;

export type PackAdvice = {
  packSize: number;
  // null when the formula fallback made the call.
  reason: string | null;
  basis: "agent" | "listings" | "estimate";
};

const DAY_MS = 24 * 60 * 60 * 1000;
const money = (n: number) => `$${n.toFixed(2)}`;

export async function advisePackSize(input: {
  upc: string | null;
  description: string;
  retailPrice: number | null;
  category: string | null;
  packStats: PackStat[];
  evaluationId?: string;
  // The scan page passes true: with no eBay listings at all the agent still
  // decides from the product, its retail price and the label cost, since
  // Lizvet is holding the item and needs a call. Seen 2026-10-15: 171 UPCs
  // on four bought pallets (store brands like Festive Voice, and products
  // only found under Liquidation.com shorthand) showed no card at all. The
  // Analyzer leaves it off, keeping its "no listings, no call" behavior.
  allowNoListings?: boolean;
  // The live Analyzer (eBay API License, see compliant in sourcingAgent.ts):
  // decides without other sellers' listings and never reuses a saved call,
  // since older ones were made from live listings.
  compliant?: boolean;
  // Compliant calls only: save it for the scan page to reuse (the live
  // Analyzer does; comparison copies don't, so they can't replace what the
  // scan page shows Lizvet). Non-compliant calls are always saved.
  saveDecision?: boolean;
}): Promise<PackAdvice | null> {
  if (input.packStats.length === 0 && !input.allowNoListings && !input.compliant) return null;

  if (input.upc && !input.compliant) {
    const saved = await savedPackDecision(input.upc);
    if (saved) return saved;
  }

  const [lessons, feedback] = await Promise.all([
    prisma.sourcingKnowledge.findUnique({ where: { scope: PACK_STRATEGY_SCOPE } }),
    prisma.packFeedback.findMany({ orderBy: { createdAt: "desc" }, take: 40 }),
  ]);

  const examples = feedback
    .map((f) => ({
      f,
      rank: f.upc === input.upc ? 0 : input.category && f.category === input.category ? 1 : 2,
    }))
    .sort((a, b) => a.rank - b.rank || b.f.createdAt.getTime() - a.f.createdAt.getTime())
    .slice(0, FEEDBACK_EXAMPLES)
    .map(({ f }) => f);

  const ownHistory = input.upc ? await ownSellSpeedForUpc(input.upc) : [];

  const [typicalLabel, unitWeightOz] = await Promise.all([
    typicalSingleLabelCost(),
    input.upc ? unitShippingWeightOz(input.upc, input.description) : Promise.resolve(null),
  ]);
  const prompt = buildPrompt({
    ...input,
    packStats: input.compliant ? [] : input.packStats,
    compliant: input.compliant ?? false,
    lessons: lessons?.notes ?? null,
    examples,
    ownHistory,
    shipping: { typicalLabel, unitWeightOz },
  });

  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-sonnet-5",
        max_tokens: 2000,
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                packSize: { type: "integer", enum: Array.from({ length: MAX_RECOMMENDED_PACK }, (_, i) => i + 1) },
                reason: { type: "string" },
              },
              required: ["packSize", "reason"],
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    await logAiUsage("pack.advice", response, { evaluationId: input.evaluationId });
    const text = response.content.find((b) => b.type === "text");
    const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as { packSize?: number; reason?: string };
    const packSize = Number(parsed.packSize);
    // Seen live: stray characters after the last sentence ("margin.“}",
    // "potential.dec").
    const reason = parsed.reason
      ?.trim()
      .replace(/["“”}]+$/, "")
      .replace(/([.!?])[^\s.!?]{1,6}$/, "$1")
      .trim();
    if (!Number.isInteger(packSize) || packSize < 1 || packSize > MAX_RECOMMENDED_PACK || !reason) {
      throw new Error(`unusable answer: ${JSON.stringify(parsed)}`);
    }
    if (input.upc && (!input.compliant || input.saveDecision)) {
      await prisma.packDecision
        .create({ data: { upc: input.upc, packSize, reason, unitWeightOz } })
        .catch((e) => console.error(`[packAdvisor] failed to save decision for ${input.upc}`, e));
    }
    return { packSize, reason, basis: "agent" };
  } catch (e) {
    console.error(`[packAdvisor] agent failed for "${input.description}", using formula`, e);
    const rec = recommendPackSize(input.packStats, input.retailPrice);
    return rec ? { packSize: rec.packSize, reason: null, basis: rec.basis } : null;
  }
}

// Liquidation.com manifests describe products in register shorthand
// ("HMPZ DK RD CH TNT LP BM BTR" = Hempz Dark Red Cherries Tinted Lip
// Balm), which finds nothing on eBay, and the free UPC database often
// doesn't know the product either. Looks up the real name from the UPC and
// the shorthand. Only called when a search came back empty. Null when it
// can't confidently tell.
export async function readableProductName(upc: string, description: string | null): Promise<string | null> {
  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-sonnet-5",
        max_tokens: 1024,
        output_config: { effort: "low" },
        // eBay blocked: the name feeds the scan page's price check.
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2, blocked_domains: EBAY_DATA_DOMAINS }],
        messages: [
          {
            role: "user",
            content: `A liquidation manifest lists a product as UPC ${upc}${description ? `, described in store-register shorthand as "${description}"` : ""}. What is the real product, the way a seller would title it on eBay (brand, product name, variant/scent/shade, size)? Search the UPC if you need to. Only answer if you're confident it's this exact product.

Respond with exactly one JSON object as your final line, no other text after it:
{"name": "Brand Product Variant Size"}
or, if you can't tell:
{"name": null}`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    await logAiUsage("pack.product_name", response);
    // A web-search answer is split across several text blocks.
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text : ""))
      .join("");
    const json = text.match(/\{[^{}]*\}\s*$/)?.[0];
    const name = json ? (JSON.parse(json) as { name?: string | null }).name?.trim() : null;
    return name || null;
  } catch (e) {
    console.error(`[packAdvisor] product name lookup failed for UPC ${upc}`, e);
    return null;
  }
}

// Shipping weight of one unit, in ounces, for pricing labels by weight on
// the scan card (Cristian, 2026-10-15: 20 ChapSticks ship for the price of
// one, so a lot of 20 beats the flat per-unit shipping guess that said
// nothing was worth listing). Real weights from earlier scans of this UPC
// win; otherwise a one-time estimate, saved on the newest PackDecision.
export async function unitShippingWeightOz(upc: string, description: string): Promise<number | null> {
  const scanned = await prisma.item.findMany({
    where: { upc, isBundle: false, OR: [{ weightLbs: { gt: 0 } }, { weightOz: { gt: 0 } }] },
    select: { weightLbs: true, weightOz: true, isMultipack: true, packSize: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const perUnit = scanned
    .map((i) => ((i.weightLbs ?? 0) * 16 + (i.weightOz ?? 0)) / (i.isMultipack && i.packSize ? i.packSize : 1))
    .filter((w) => w > 0)
    .sort((a, b) => a - b);
  if (perUnit.length > 0) return perUnit[Math.floor(perUnit.length / 2)];

  const weighed = await prisma.packDecision.findFirst({
    where: { upc, unitWeightOz: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (weighed?.unitWeightOz) return weighed.unitWeightOz;
  const decision = await prisma.packDecision.findFirst({ where: { upc }, orderBy: { createdAt: "desc" } });

  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-sonnet-5",
        max_tokens: 300,
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { ounces: { type: "number" } },
              required: ["ounces"],
              additionalProperties: false,
            },
          },
        },
        messages: [
          {
            role: "user",
            content: `About how much does ONE unit of this product weigh for shipping, in ounces, including its own retail packaging (box, blister card, cap) but not a shipping box? Give a realistic typical weight, not a padded one: the shipping box is added separately. For reference, a lip balm tube is about 0.3 oz.

Product: "${description}" (UPC ${upc})`,
          },
        ],
      },
      { timeout: 20_000, maxRetries: 0 }
    );
    await logAiUsage("pack.unit_weight", response);
    const text = response.content.find((b) => b.type === "text");
    const ounces = Number((JSON.parse(text && "text" in text ? text.text : "{}") as { ounces?: number }).ounces);
    if (!Number.isFinite(ounces) || ounces <= 0 || ounces > 800) return null;
    if (decision) await prisma.packDecision.update({ where: { id: decision.id }, data: { unitWeightOz: ounces } });
    return ounces;
  } catch (e) {
    console.error(`[packAdvisor] weight estimate failed for UPC ${upc}`, e);
    return null;
  }
}

// A still-valid earlier call for this UPC, from the Analyzer or an earlier
// scan. Any correction from Cristian made since (for any product) retires
// it, because a correction is a lesson that can change other calls too.
// The weekly sell-speed refresh of the lessons doesn't, or every saved call
// would be thrown away each week.
export async function savedPackDecision(upc: string): Promise<PackAdvice | null> {
  const cached = await prisma.packDecision.findFirst({
    where: {
      upc,
      createdAt: { gte: new Date(Math.max(Date.now() - DECISION_REUSE_DAYS * DAY_MS, REAL_SHIPPING_SINCE.getTime())) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!cached) return null;
  const newerCorrection = await prisma.packFeedback.findFirst({ where: { createdAt: { gt: cached.createdAt } }, select: { id: true } });
  if (newerCorrection) return null;
  return { packSize: cached.packSize, reason: cached.reason, basis: "agent" };
}

function buildPrompt(input: {
  description: string;
  retailPrice: number | null;
  category: string | null;
  packStats: PackStat[];
  compliant: boolean;
  lessons: string | null;
  shipping: { typicalLabel: number; unitWeightOz: number | null };
  examples: { description: string; suggestedPackSize: number | null; chosenPackSize: number; reason: string }[];
  ownHistory: string[];
}): string {
  // The label for a box of this many units: by weight when the unit weight
  // is known (USPS charges the same for anything under 1 lb), else the
  // typical label plus a rough amount per extra unit.
  const { typicalLabel, unitWeightOz } = input.shipping;
  const labelFor = (units: number) =>
    unitWeightOz != null
      ? labelForWeight(typicalLabel, (unitWeightOz * units + PACKAGING_OZ) / 16)
      : typicalLabel + SHIPPING_PER_EXTRA_UNIT * (units - 1);
  const keepPerUnit = (price: number, units: number) =>
    (price * (1 - FALLBACK_FEE_RATE) - FALLBACK_FEE_FIXED - labelFor(units)) / units;
  const underOneLb = unitWeightOz != null ? Math.floor((16 - PACKAGING_OZ) / unitWeightOz) : null;
  const shippingLine =
    unitWeightOz != null
      ? `shipping label ~${money(typicalLabel)} for any box under 1 lb. One unit weighs about ${unitWeightOz} oz, so ${underOneLb != null && underOneLb >= 1 ? `up to ${underOneLb} unit${underOneLb === 1 ? "" : "s"} ship for that same label` : "even one unit is over 1 lb"}; heavier boxes cost more (a ${packWord(MAX_RECOMMENDED_PACK)} box would be ~${money(labelFor(MAX_RECOMMENDED_PACK))})`
      : `shipping label ~${money(typicalLabel)} plus ~${money(SHIPPING_PER_EXTRA_UNIT)} per extra unit in the box`;
  const market = input.packStats
    .filter((s) => s.packSize <= 12)
    .map((s) => {
      const label = s.packSize === 1 ? "Singles" : `${s.packSize}-packs`;
      const lowest =
        s.lowestTotal != null
          ? `, cheapest ${money(s.lowestTotal)} (${money(s.lowestTotal / s.packSize)} per unit to the buyer)${s.cheapestTitle ? `: "${s.cheapestTitle}"` : ""}`
          : "";
      return `- ${label}: ${s.count} active listing${s.count === 1 ? "" : "s"}, typical ${money(s.medianTotal)} (${money(s.medianTotal / s.packSize)} per unit to the buyer)${lowest}. At the typical price Cristian would keep about ${money(keepPerUnit(s.medianTotal, s.packSize))} per unit (${money(keepPerUnit(s.medianTotal, s.packSize) * s.packSize)} per listing).`;
    })
    .join("\n");

  const examples = input.examples
    .map(
      (f) =>
        `- "${f.description}": ${f.suggestedPackSize != null ? `the suggestion was ${packWord(f.suggestedPackSize)}, ` : ""}Cristian chose ${packWord(f.chosenPackSize)}. His reason: "${f.reason}"`
    )
    .join("\n");

  return `You decide how Cristian should list a product on eBay: as singles, or as multi-packs of 2 to ${MAX_RECOMMENDED_PACK} units per listing. He resells liquidation stock.

His goal: sell stock through quickly while still making a profit. He'd rather make a bit less per unit and sell out in a few weeks than hold out for the most money per unit and sit on it for months. Profit still matters: don't pick a pack that loses money when a profitable option exists.

Before the numbers, think like a buyer: why would someone buy this on eBay instead of at a store? For everyday products people can pick up at any store, eBay buyers are looking for a deal, which usually means a lower price per unit, so a single priced at or above store retail tends to sit unsold while a multi-pack sells. Products people can't easily get in a store (collectibles, hype items, discontinued or hard-to-find things) are different and can sell fine as singles, even above retail. These are active asking prices, not sales: a listing priced well above retail may just be sitting there. The number of listings shows how many sellers compete, not how many buyers there are, so don't read it as demand. Nothing below shows actual sales except Cristian's own history. Compare what a buyer pays per unit across pack sizes, since that's what they compare.

Product: "${input.description}"
Store retail per unit (from the liquidation manifest): ${input.retailPrice != null && input.retailPrice > 0 ? money(input.retailPrice) : "unknown"}
Category: ${input.category ?? "unknown"}

${
  input.compliant
    ? "Other sellers' eBay listings: not used. This call is made without looking at other sellers' listings or prices. Decide from what the product is, its store retail price, Cristian's own history and the costs below. Don't mention other listings in the reason."
    : `Live eBay listings by pack size:
${market || "None. Nobody has this exact product listed on eBay right now (searched by UPC and by name), so there's nothing to compare against. Decide from what the product is, its store retail price and the costs below, and say in the reason that there were no eBay listings to go by."}`
}

Cost assumptions behind "keep about": eBay fees ~${(FALLBACK_FEE_RATE * 100).toFixed(2)}% + ${money(FALLBACK_FEE_FIXED)}, ${shippingLine}. When a bigger pack ships for the same label, it usually keeps much more per listing, so weigh that against how much slower a bigger pack might sell. You can pick a pack size nobody lists yet if your reasoning supports it.

Cristian's own past listings of this exact product:
${input.ownHistory.length > 0 ? input.ownHistory.join("\n") : "none yet"}

Lessons learned so far about pack sizes:
${input.lessons ?? "none yet"}

Recent times Cristian corrected a pack-size call (learn from his reasoning, not just the item):
${examples || "none yet"}

Reply with the pack size and a reason: one or two plain sentences the person scanning the item will read. Say what drove the call in everyday words. No dollar amounts in the reason, and don't claim things sell or that buyers want them unless Cristian's own history shows it.`;
}

function packWord(size: number): string {
  return size > 1 ? `${size}-packs` : "singles";
}

// How fast Cristian's own listings of this UPC sold, by pack size — the
// most direct speed evidence there is, when it exists.
async function ownSellSpeedForUpc(upc: string): Promise<string[]> {
  const items = await prisma.item.findMany({
    where: { upc, isBundle: false, ebayPublishedAt: { not: null } },
    select: { isMultipack: true, packSize: true, ebayPublishedAt: true, sales: { select: { soldAt: true } } },
  });
  return summarizeSpeed(items).map((g) => `- ${g}`);
}

type SpeedItem = {
  isMultipack: boolean;
  packSize: number | null;
  ebayPublishedAt: Date | null;
  sales: { soldAt: Date }[];
};

// "3-packs: 4 listed, 3 sold at least once, median 6 days to the first
// sale" per pack size.
function summarizeSpeed(items: SpeedItem[], minListings = 1): string[] {
  const byPack = new Map<number, { listed: number; firstSaleDays: number[] }>();
  for (const i of items) {
    if (!i.ebayPublishedAt) continue;
    const size = i.isMultipack && i.packSize ? i.packSize : 1;
    const group = byPack.get(size) ?? { listed: 0, firstSaleDays: [] };
    group.listed++;
    const first = i.sales.reduce<Date | null>((min, s) => (!min || s.soldAt < min ? s.soldAt : min), null);
    if (first) group.firstSaleDays.push(Math.max(0, (first.getTime() - i.ebayPublishedAt.getTime()) / DAY_MS));
    byPack.set(size, group);
  }
  return [...byPack.entries()]
    .filter(([, g]) => g.listed >= minListings)
    .sort(([a], [b]) => a - b)
    .map(([size, g]) => {
      const sorted = g.firstSaleDays.sort((a, b) => a - b);
      const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null;
      return `${packWord(size)}: ${g.listed} listed, ${sorted.length} sold at least once${median != null ? `, median ${Math.round(median)} days to the first sale` : ""}`;
    });
}

// ---------------------------------------------------------------------------
// Learning pass — piggybacks on the 4-hourly order-sync cron, like
// updateSourcingKnowledge. Folds Cristian's new corrections and real
// sell-speed by pack size into the "pack_strategy" lessons note every
// decision reads.
// ---------------------------------------------------------------------------
export async function updatePackStrategyKnowledge(): Promise<void> {
  const existing = await prisma.sourcingKnowledge.findUnique({ where: { scope: PACK_STRATEGY_SCOPE } });
  const since = existing?.updatedAt ?? new Date(0);
  const newFeedback = await prisma.packFeedback.findMany({ where: { createdAt: { gt: since } }, orderBy: { createdAt: "asc" } });
  const due = !existing || Date.now() - existing.updatedAt.getTime() >= LESSONS_REFRESH_DAYS * DAY_MS;
  if (newFeedback.length === 0 && !due) return;

  const speedByCategory = await sellSpeedByCategory();
  if (newFeedback.length === 0 && speedByCategory.length === 0) return;

  const prompt = `You maintain the lessons a pack-size agent reads before deciding whether a product should be listed on eBay as singles or multi-packs. The seller is Cristian, who resells liquidation stock. His goal is to sell through quickly at a profit, not to get the most money per unit.

Current lessons:
${existing?.notes ?? "none yet"}

New corrections from Cristian since the last update:
${newFeedback.map((f) => `- "${f.description}"${f.category ? ` (${f.category})` : ""}: ${f.suggestedPackSize != null ? `suggested ${packWord(f.suggestedPackSize)}, ` : ""}he chose ${packWord(f.chosenPackSize)}. His reason: "${f.reason}"`).join("\n") || "none"}

How fast his own eBay listings have actually sold, by category and pack size (all time):
${speedByCategory.join("\n") || "not enough data yet"}

Rewrite the lessons. Keep Cristian's own stated reasoning, including any explanation he's given for his own data. Turn each correction into a general lesson about why, one that would apply to other products, not a note about that one item. Use the sell-speed data only where there are enough listings to mean something, and say so when it backs up or contradicts a lesson. A category that sells slowly at every pack size says the products are slow sellers, not which pack size is better: only compare pack sizes against each other. Short plain sentences, at most 10. Output only the lessons.`;

  try {
    const response = await anthropic.messages.create(
      { model: "claude-sonnet-5", max_tokens: 3000, output_config: { effort: "medium" }, messages: [{ role: "user", content: prompt }] },
      { timeout: 60_000, maxRetries: 0 }
    );
    await logAiUsage("pack.lessons_update", response);
    const notes = response.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text : ""))
      .join("")
      .trim();
    if (!notes) return;
    await prisma.sourcingKnowledge.upsert({
      where: { scope: PACK_STRATEGY_SCOPE },
      create: { scope: PACK_STRATEGY_SCOPE, notes },
      update: { notes },
    });
  } catch (e) {
    console.error("[packAdvisor] lessons update failed", e);
  }
}

async function sellSpeedByCategory(): Promise<string[]> {
  const items = await prisma.item.findMany({
    where: { isBundle: false, ebayPublishedAt: { not: null }, upc: { not: null } },
    select: { upc: true, isMultipack: true, packSize: true, ebayPublishedAt: true, sales: { select: { soldAt: true } } },
  });
  if (items.length === 0) return [];
  const lines = await prisma.manifestLine.findMany({
    where: { upc: { in: [...new Set(items.map((i) => i.upc!))] }, category: { not: null } },
    select: { upc: true, category: true },
  });
  const categoryByUpc = new Map(lines.map((l) => [l.upc!, l.category!]));
  const byCategory = new Map<string, SpeedItem[]>();
  for (const i of items) {
    const category = categoryByUpc.get(i.upc!) ?? "Uncategorized";
    byCategory.set(category, [...(byCategory.get(category) ?? []), i]);
  }
  return [...byCategory.entries()]
    .map(([category, group]) => ({ category, lines: summarizeSpeed(group, 5) }))
    .filter((c) => c.lines.length > 0)
    .map((c) => `${c.category}: ${c.lines.join("; ")}`);
}
