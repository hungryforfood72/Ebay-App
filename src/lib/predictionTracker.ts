import { anthropic } from "./anthropic";
import { logAiUsage } from "./aiUsage";
import { prisma } from "./prisma";
import { NOT_RETURN_ENTRY } from "./warehouse/returnReconcile";

// ---------------------------------------------------------------------------
// Prediction tracker: the Analyzer's report card. Cristian's ask 2026-10-17:
// keep track of the Analyzer's guesses, compare them to what really
// happened, and get better the more he sells.
//
// Three steps, run by the 4-hourly full-sync cron (runPredictionTracker):
//   1. refreshPredictionOutcomes: for every bought manifest with an
//      evaluation, one PredictionOutcome row per UPC: the latest complete
//      evaluation's guess next to real results (units listed/sold, eBay
//      price and net per unit, how fast it sold).
//   2. updateCalibration: turns those into two correction factors the
//      Analyzer applies on its next runs (SourcingCalibration): "price" for
//      market-based price estimates, "speed" for the live-listings sell
//      rate. Shrunk toward 1 until there's a real sample, and clamped, so a
//      handful of odd products can't swing every future bid.
//   3. updateAccuracyLessons: when there are new results, Claude reads the
//      biggest misses and keeps a short "accuracy" note that the Analyzer's
//      reasoning reads on every evaluation.
// ---------------------------------------------------------------------------

// Months with no sales that the Analyzer encodes as "stalled" (see
// STALLED_MONTHS_SENTINEL in sourcingAgent.ts).
const STALLED_MONTHS = 9999;
const DAY_MS = 24 * 60 * 60 * 1000;
// Too soon to judge speed before this, unless it already sold out.
const MIN_MONTHS_FOR_SPEED = 0.5;
// Speed only counts toward the correction once a product has had a month.
const MIN_MONTHS_FOR_SPEED_CALIBRATION = 1;

// Price guesses from evaluations before the 2026-09-26 pricing fixes
// (b7cfd69 and the 1.5x retail cap) are known to be inflated, so they're
// shown on the report card but don't train the correction. Speed is only
// trained on live-listings guesses, which started 2026-10-16.
const PRICE_CALIBRATION_SINCE = new Date("2026-09-27T00:00:00Z");
// Products needed before a correction is used at all, and the sample size
// at which it's trusted fully.
const MIN_CALIBRATION_SAMPLE = 8;
const FULL_TRUST_SAMPLE = 30;
const PRICE_FACTOR_BOUNDS = [0.6, 1.25] as const;
const SPEED_FACTOR_BOUNDS = [0.5, 2] as const;

export const ACCURACY_KNOWLEDGE_SCOPE = "accuracy";

function physicalUnits(quantity: number, item: { isMultipack: boolean; packSize: number | null }): number {
  return quantity * (item.isMultipack && item.packSize ? item.packSize : 1);
}

export async function refreshPredictionOutcomes(): Promise<{ manifests: number; products: number }> {
  const manifests = await prisma.manifest.findMany({
    where: { purchased: true, sourcingEvaluations: { some: { status: "complete" } } },
    select: {
      id: true,
      supplier: true,
      sourcingEvaluations: {
        where: { status: "complete" },
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { id: true, startedAt: true, lineEstimates: true },
      },
    },
  });

  let products = 0;
  for (const manifest of manifests) {
    const evaluation = manifest.sourcingEvaluations[0];
    const estimates = evaluation.lineEstimates.filter((e) => e.upc);
    if (estimates.length === 0) continue;
    const upcs = estimates.map((e) => e.upc!);

    const [items, duds, walkups] = await Promise.all([
      prisma.item.findMany({
        where: { manifestId: manifest.id, upc: { in: upcs }, isBundle: false },
        select: {
          id: true,
          upc: true,
          quantity: true,
          isMultipack: true,
          packSize: true,
          ebayPublishedAt: true,
          createdAt: true,
          sales: { select: { quantity: true, revenue: true, fees: true, shipping: true, soldAt: true } },
        },
      }),
      prisma.manifestDudEntry.groupBy({
        by: ["upc"],
        // A customer return's donated units aren't the Analyzer's duds.
        where: { manifestId: manifest.id, upc: { in: upcs }, ...NOT_RETURN_ENTRY },
        _sum: { quantity: true, listedUnits: true },
      }),
      prisma.manifestWalkupSale.groupBy({
        by: ["upc"],
        where: { manifestId: manifest.id, upc: { in: upcs } },
        _sum: { quantity: true },
      }),
    ]);
    const itemIds = items.map((i) => i.id);
    const [shopifySales, inPersonSales] = await Promise.all([
      prisma.shopifySale.findMany({ where: { itemId: { in: itemIds } }, select: { itemId: true, quantity: true, soldAt: true } }),
      prisma.inPersonSale.findMany({ where: { itemId: { in: itemIds } }, select: { itemId: true, quantity: true, soldAt: true } }),
    ]);
    // Dud units since listed from a dud box are Items now (in listedUnits
    // below), so only what's still a dud counts.
    const dudByUpc = new Map(duds.map((d) => [d.upc, (d._sum.quantity ?? 0) - (d._sum.listedUnits ?? 0)]));
    const walkupByUpc = new Map(walkups.map((w) => [w.upc, w._sum.quantity ?? 0]));

    for (const est of estimates) {
      const upc = est.upc!;
      const upcItems = items.filter((i) => i.upc === upc);
      const byId = new Map(upcItems.map((i) => [i.id, i]));

      let listedUnits = 0;
      let firstListedAt: Date | null = null;
      for (const i of upcItems) {
        listedUnits += physicalUnits(i.quantity, i);
        const listedAt = i.ebayPublishedAt ?? i.createdAt;
        if (!firstListedAt || listedAt < firstListedAt) firstListedAt = listedAt;
      }

      // Every channel counts toward speed; only eBay toward price, since
      // the guess is an eBay price (Shopify runs a set discount).
      let soldUnits = 0;
      let lastSoldAt: Date | null = null;
      let ebayUnits = 0;
      let ebayRevenue = 0;
      let ebayNet = 0;
      const countSale = (units: number, soldAt: Date) => {
        soldUnits += units;
        if (!lastSoldAt || soldAt > lastSoldAt) lastSoldAt = soldAt;
      };
      for (const i of upcItems) {
        for (const s of i.sales) {
          const units = physicalUnits(s.quantity, i);
          countSale(units, s.soldAt);
          ebayUnits += units;
          ebayRevenue += Number(s.revenue);
          ebayNet += Number(s.revenue) - Number(s.fees) - Number(s.shipping);
        }
      }
      for (const s of [...shopifySales, ...inPersonSales]) {
        const item = byId.get(s.itemId);
        if (item) countSale(physicalUnits(s.quantity, item), s.soldAt);
      }

      // Speed: units per month from first listing until now, or until the
      // last sale if everything listed is gone (selling out early shouldn't
      // read as slow).
      let monthsActive: number | null = null;
      let actualUnitsPerMonth: number | null = null;
      if (firstListedAt && listedUnits > 0) {
        const soldOut = soldUnits >= listedUnits && lastSoldAt != null;
        const end = soldOut ? lastSoldAt! : new Date();
        monthsActive = Math.max(0, (end.getTime() - firstListedAt.getTime()) / (30 * DAY_MS));
        if (soldOut || monthsActive >= MIN_MONTHS_FOR_SPEED) {
          actualUnitsPerMonth = soldUnits / Math.max(monthsActive, 1 / 30);
        }
      }

      const months = est.monthsToSellThrough;
      const predictedUnitsPerMonth =
        months == null ? null : months >= STALLED_MONTHS ? 0 : months > 0 ? est.effectiveUnits / months : null;
      const predictedUnitPrice = est.estimatedUnitSalePrice != null ? Number(est.estimatedUnitSalePrice) : null;
      const actualUnitPrice = ebayUnits > 0 ? ebayRevenue / ebayUnits : null;

      const data = {
        evaluationId: evaluation.id,
        evaluatedAt: evaluation.startedAt,
        supplier: manifest.supplier,
        description: est.description,
        dataConfidence: est.dataConfidence,
        sellRateSource: est.sellRateSource,
        predictedDud: est.flaggedDud,
        predictedUnitPrice,
        predictedNetPerUnit: est.estimatedNetPerUnit != null ? Number(est.estimatedNetPerUnit) : null,
        predictedUnitsPerMonth,
        expectedUnits: est.effectiveUnits,
        listedUnits,
        soldUnits: soldUnits + (walkupByUpc.get(upc) ?? 0),
        dudUnits: dudByUpc.get(upc) ?? 0,
        ebayUnitsSold: ebayUnits,
        actualUnitPrice,
        actualNetPerUnit: ebayUnits > 0 ? ebayNet / ebayUnits : null,
        firstListedAt,
        lastSoldAt,
        monthsActive,
        actualUnitsPerMonth,
        priceRatio: predictedUnitPrice && actualUnitPrice != null ? actualUnitPrice / predictedUnitPrice : null,
        speedRatio:
          predictedUnitsPerMonth && actualUnitsPerMonth != null ? actualUnitsPerMonth / predictedUnitsPerMonth : null,
      };
      await prisma.predictionOutcome.upsert({
        where: { manifestId_upc: { manifestId: manifest.id, upc } },
        create: { manifestId: manifest.id, upc, ...data },
        update: data,
      });
      products++;
    }
  }
  return { manifests: manifests.length, products };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Median actual/predicted ratio, pulled toward 1 while the sample is small
// and clamped. Below MIN_CALIBRATION_SAMPLE products the factor is 1.
function correction(ratios: number[], bounds: readonly [number, number]) {
  if (ratios.length === 0) return { factor: 1, rawMedian: 1, sampleSize: 0 };
  const rawMedian = median(ratios);
  if (ratios.length < MIN_CALIBRATION_SAMPLE) return { factor: 1, rawMedian, sampleSize: ratios.length };
  const trust = Math.min(1, ratios.length / FULL_TRUST_SAMPLE);
  const factor = Math.min(bounds[1], Math.max(bounds[0], 1 + (rawMedian - 1) * trust));
  return { factor, rawMedian, sampleSize: ratios.length };
}

export async function updateCalibration(): Promise<{ price: number; speed: number }> {
  const outcomes = await prisma.predictionOutcome.findMany({
    where: { OR: [{ priceRatio: { not: null } }, { speedRatio: { not: null } }] },
    select: {
      priceRatio: true,
      speedRatio: true,
      evaluatedAt: true,
      dataConfidence: true,
      supplier: true,
      sellRateSource: true,
      monthsActive: true,
      soldUnits: true,
      listedUnits: true,
    },
  });

  // Price: market-based guesses only (our own sales history needs no
  // correction), and only the BStock / Liquidation.com pricing path.
  const priceRatios = outcomes
    .filter(
      (o) =>
        o.priceRatio != null &&
        o.evaluatedAt >= PRICE_CALIBRATION_SINCE &&
        o.dataConfidence !== "own_history" &&
        o.supplier !== "unknown"
    )
    .map((o) => o.priceRatio!);
  // Speed: live-listings guesses that have had time to show a real pace.
  const speedRatios = outcomes
    .filter(
      (o) =>
        o.speedRatio != null &&
        o.sellRateSource === "ebay_listings" &&
        ((o.monthsActive ?? 0) >= MIN_MONTHS_FOR_SPEED_CALIBRATION || o.soldUnits >= o.listedUnits)
    )
    // A product that sold 20x faster than guessed shouldn't outvote the rest.
    .map((o) => Math.min(o.speedRatio!, 10));

  const price = correction(priceRatios, PRICE_FACTOR_BOUNDS);
  const speed = correction(speedRatios, SPEED_FACTOR_BOUNDS);
  await prisma.$transaction([
    prisma.sourcingCalibration.upsert({ where: { kind: "price" }, create: { kind: "price", ...price }, update: price }),
    prisma.sourcingCalibration.upsert({ where: { kind: "speed" }, create: { kind: "speed", ...speed }, update: speed }),
  ]);
  return { price: price.factor, speed: speed.factor };
}

export async function getCalibration(): Promise<{ price: number; speed: number }> {
  const rows = await prisma.sourcingCalibration.findMany();
  const factor = (kind: string) => rows.find((r) => r.kind === kind)?.factor ?? 1;
  return { price: factor("price"), speed: factor("speed") };
}

function describeOutcome(o: {
  description: string;
  predictedDud: boolean;
  predictedUnitPrice: unknown;
  actualUnitPrice: unknown;
  predictedUnitsPerMonth: number | null;
  actualUnitsPerMonth: number | null;
  sellRateSource: string | null;
  dataConfidence: string;
  listedUnits: number;
  soldUnits: number;
  monthsActive: number | null;
}): string {
  const parts = [`${o.description}:`];
  if (o.predictedDud) parts.push("called a dud;");
  if (o.predictedUnitPrice != null && o.actualUnitPrice != null)
    parts.push(`guessed $${Number(o.predictedUnitPrice).toFixed(2)}/unit (${o.dataConfidence}), sold at $${Number(o.actualUnitPrice).toFixed(2)};`);
  if (o.predictedUnitsPerMonth != null)
    parts.push(`guessed ${o.predictedUnitsPerMonth.toFixed(1)} units/month (${o.sellRateSource ?? "?"})${o.actualUnitsPerMonth != null ? `, really ${o.actualUnitsPerMonth.toFixed(1)}` : ""};`);
  parts.push(`${o.soldUnits} of ${o.listedUnits} listed sold in ${(o.monthsActive ?? 0).toFixed(1)} months.`);
  return parts.join(" ");
}

// Only does an LLM call when some outcome changed since the note was last
// written. The note is narrative for the Analyzer's reasoning; the numbers
// themselves learn through updateCalibration.
export async function updateAccuracyLessons(): Promise<void> {
  const existing = await prisma.sourcingKnowledge.findUnique({ where: { scope: ACCURACY_KNOWLEDGE_SCOPE } });
  const since = existing?.updatedAt ?? new Date(0);
  const changed = await prisma.predictionOutcome.count({ where: { updatedAt: { gt: since }, soldUnits: { gt: 0 } } });
  if (changed === 0) return;

  const outcomes = await prisma.predictionOutcome.findMany({
    where: { OR: [{ soldUnits: { gt: 0 } }, { listedUnits: { gt: 0 } }] },
  });
  const logMiss = (r: number | null) => (r != null && r > 0 ? Math.abs(Math.log(r)) : 0);
  const biggestPriceMisses = outcomes
    .filter((o) => o.priceRatio != null)
    .sort((a, b) => logMiss(b.priceRatio) - logMiss(a.priceRatio))
    .slice(0, 8);
  const biggestSpeedMisses = outcomes
    .filter((o) => o.speedRatio != null)
    .sort((a, b) => logMiss(b.speedRatio) - logMiss(a.speedRatio))
    .slice(0, 8);
  const dudsThatSold = outcomes.filter((o) => o.predictedDud && o.soldUnits > 0).slice(0, 8);
  const stuck = outcomes
    .filter((o) => !o.predictedDud && o.listedUnits > 0 && o.soldUnits === 0 && (o.monthsActive ?? 0) >= 1)
    .slice(0, 8);
  const calibration = await prisma.sourcingCalibration.findMany();

  const prompt = `You keep a short running note on how accurate a liquidation-reselling sourcing Analyzer has been, by comparing its guesses on manifests that were actually bought with what really happened on eBay. The Analyzer reads this note when explaining future buy/bid calls.

Current note:
${existing?.notes ?? "(none yet)"}

Correction factors in use (actual / guessed, already shrunk for small samples; 1 = no correction):
${calibration.map((c) => `- ${c.kind}: factor ${c.factor.toFixed(2)} (raw median ${c.rawMedian.toFixed(2)} over ${c.sampleSize} products)`).join("\n") || "none yet"}

Products tracked: ${outcomes.length}, with sales: ${outcomes.filter((o) => o.soldUnits > 0).length}.

Biggest price misses:
${biggestPriceMisses.map(describeOutcome).join("\n") || "none"}

Biggest speed misses:
${biggestSpeedMisses.map(describeOutcome).join("\n") || "none"}

Called a dud but sold anyway:
${dudsThatSold.map(describeOutcome).join("\n") || "none"}

Expected to sell but nothing sold after a month or more:
${stuck.map(describeOutcome).join("\n") || "none"}

Context on older guesses: ones made before late September 2026 used older, known-inflated pricing, so don't over-weight their price misses. Until 2026-10-16 the Analyzer also called popular items duds just for having lots of competing listings, a rule that has since been removed, so dud calls from before then are partly explained by it.

Rewrite the note in 3-6 plain sentences, under 130 words: where the Analyzer runs high or low, for which kinds of products or data sources, and what that means for future bids. Patterns only, not a list of products. If there's too little data to say much, say that plainly. No headings, no em dashes.`;

  try {
    const response = await anthropic.messages.create(
      { model: "claude-sonnet-5", max_tokens: 800, messages: [{ role: "user", content: prompt }] },
      { timeout: 60_000, maxRetries: 1 }
    );
    await logAiUsage("sourcing.accuracy_lessons", response);
    const notes = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    if (!notes) return;
    await prisma.sourcingKnowledge.upsert({
      where: { scope: ACCURACY_KNOWLEDGE_SCOPE },
      create: { scope: ACCURACY_KNOWLEDGE_SCOPE, notes },
      update: { notes },
    });
  } catch (e) {
    console.error("[predictionTracker] accuracy lessons failed", e);
  }
}

export async function runPredictionTracker() {
  const refreshed = await refreshPredictionOutcomes();
  const calibration = await updateCalibration();
  await updateAccuracyLessons();
  return { ...refreshed, calibration };
}
