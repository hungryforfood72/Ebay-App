import { prisma } from "./prisma";
import { anthropic } from "./anthropic";
import { logAiUsage } from "./aiUsage";
import {
  FALLBACK_FEE_FIXED,
  FALLBACK_FEE_RATE,
  FALLBACK_SHIPPING_COST,
  MAX_RECOMMENDED_PACK,
  SHIPPING_PER_EXTRA_UNIT,
  netPerUnit,
  recommendPackSize,
  type PackStat,
} from "./packSize";

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
const DECISION_REUSE_DAYS = 7;
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
}): Promise<PackAdvice | null> {
  // No live listings at all: nothing for the agent (or the formula) to
  // weigh. Same "no suggestion" as before.
  if (input.packStats.length === 0) return null;

  const [lessons, feedback] = await Promise.all([
    prisma.sourcingKnowledge.findUnique({ where: { scope: PACK_STRATEGY_SCOPE } }),
    prisma.packFeedback.findMany({ orderBy: { createdAt: "desc" }, take: 40 }),
  ]);

  if (input.upc) {
    const latestForUpc = feedback.find((f) => f.upc === input.upc)?.createdAt ?? null;
    const cached = await prisma.packDecision.findFirst({
      where: { upc: input.upc, createdAt: { gte: new Date(Date.now() - DECISION_REUSE_DAYS * DAY_MS) } },
      orderBy: { createdAt: "desc" },
    });
    const stale =
      !cached ||
      (latestForUpc && latestForUpc > cached.createdAt) ||
      (lessons && lessons.updatedAt > cached.createdAt);
    if (cached && !stale) return { packSize: cached.packSize, reason: cached.reason, basis: "agent" };
  }

  const examples = feedback
    .map((f) => ({
      f,
      rank: f.upc === input.upc ? 0 : input.category && f.category === input.category ? 1 : 2,
    }))
    .sort((a, b) => a.rank - b.rank || b.f.createdAt.getTime() - a.f.createdAt.getTime())
    .slice(0, FEEDBACK_EXAMPLES)
    .map(({ f }) => f);

  const ownHistory = input.upc ? await ownSellSpeedForUpc(input.upc) : [];

  const prompt = buildPrompt({ ...input, lessons: lessons?.notes ?? null, examples, ownHistory });

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
    if (input.upc) {
      await prisma.packDecision
        .create({ data: { upc: input.upc, packSize, reason } })
        .catch((e) => console.error(`[packAdvisor] failed to save decision for ${input.upc}`, e));
    }
    return { packSize, reason, basis: "agent" };
  } catch (e) {
    console.error(`[packAdvisor] agent failed for "${input.description}", using formula`, e);
    const rec = recommendPackSize(input.packStats, input.retailPrice);
    return rec ? { packSize: rec.packSize, reason: null, basis: rec.basis } : null;
  }
}

function buildPrompt(input: {
  description: string;
  retailPrice: number | null;
  category: string | null;
  packStats: PackStat[];
  lessons: string | null;
  examples: { description: string; suggestedPackSize: number | null; chosenPackSize: number; reason: string }[];
  ownHistory: string[];
}): string {
  const market = input.packStats
    .filter((s) => s.packSize <= 12)
    .map((s) => {
      const label = s.packSize === 1 ? "Singles" : `${s.packSize}-packs`;
      const lowest =
        s.lowestTotal != null
          ? `, cheapest ${money(s.lowestTotal)} (${money(s.lowestTotal / s.packSize)} per unit to the buyer)${s.cheapestTitle ? `: "${s.cheapestTitle}"` : ""}`
          : "";
      return `- ${label}: ${s.count} active listing${s.count === 1 ? "" : "s"}, typical ${money(s.medianTotal)} (${money(s.medianTotal / s.packSize)} per unit to the buyer)${lowest}. At the typical price Cristian would keep about ${money(netPerUnit(s.medianTotal, s.packSize))} per unit.`;
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

Live eBay listings by pack size:
${market}

Cost assumptions behind "keep about": eBay fees ~${(FALLBACK_FEE_RATE * 100).toFixed(2)}% + ${money(FALLBACK_FEE_FIXED)}, shipping label ~${money(FALLBACK_SHIPPING_COST)} plus ~${money(SHIPPING_PER_EXTRA_UNIT)} per extra unit in the box. You can pick a pack size nobody lists yet if your reasoning supports it.

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
