import { prisma } from "./prisma";

// Same key/value AppSetting store already used for the sourcing agent's
// target margin (see getTargetMarginPct in sourcingAgent.ts) — separate
// keys on purpose, not shared with that setting, since a walk-up sale's
// pricing and a pre-purchase bid decision are conceptually different even
// though the defaults happen to start at the same 35%.
const FLOOR_MARGIN_KEY = "walkup_sale_floor_margin_pct";
const IDEAL_RETAIL_KEY = "walkup_sale_ideal_retail_pct";
const NEAR_EXPIRY_RETAIL_KEY = "walkup_sale_near_expiry_retail_pct";

const DEFAULT_FLOOR_MARGIN_PCT = 35;
const DEFAULT_IDEAL_RETAIL_PCT = 40;
const DEFAULT_NEAR_EXPIRY_RETAIL_PCT = 20;

export type WalkupSaleSettings = {
  floorMarginPct: number;
  idealRetailPct: number;
  nearExpiryRetailPct: number;
};

function parsePositive(value: string | undefined, fallback: number): number {
  const n = value != null ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function getWalkupSaleSettings(): Promise<WalkupSaleSettings> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [FLOOR_MARGIN_KEY, IDEAL_RETAIL_KEY, NEAR_EXPIRY_RETAIL_KEY] } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    floorMarginPct: parsePositive(byKey.get(FLOOR_MARGIN_KEY), DEFAULT_FLOOR_MARGIN_PCT),
    idealRetailPct: parsePositive(byKey.get(IDEAL_RETAIL_KEY), DEFAULT_IDEAL_RETAIL_PCT),
    nearExpiryRetailPct: parsePositive(byKey.get(NEAR_EXPIRY_RETAIL_KEY), DEFAULT_NEAR_EXPIRY_RETAIL_PCT),
  };
}

export async function setWalkupSaleSettings(settings: WalkupSaleSettings): Promise<void> {
  await prisma.$transaction([
    prisma.appSetting.upsert({
      where: { key: FLOOR_MARGIN_KEY },
      create: { key: FLOOR_MARGIN_KEY, value: String(settings.floorMarginPct) },
      update: { value: String(settings.floorMarginPct) },
    }),
    prisma.appSetting.upsert({
      where: { key: IDEAL_RETAIL_KEY },
      create: { key: IDEAL_RETAIL_KEY, value: String(settings.idealRetailPct) },
      update: { value: String(settings.idealRetailPct) },
    }),
    prisma.appSetting.upsert({
      where: { key: NEAR_EXPIRY_RETAIL_KEY },
      create: { key: NEAR_EXPIRY_RETAIL_KEY, value: String(settings.nearExpiryRetailPct) },
      update: { value: String(settings.nearExpiryRetailPct) },
    }),
  ]);
}

export type WalkupPrices = {
  floorPrice: number | null;
  idealPrice: number;
  nearExpiryPrice: number;
};

// Floor is cost-anchored (protects real profit over what was actually
// paid); ideal and near-expiry are retail-anchored (a thin markup over a
// tiny liquidation landed cost reads as "way too cheap" for a walk-up
// buyer who has no idea what Cristian paid — retail is what they're
// actually comparing against). Ideal is clamped to never read below the
// floor, in case an unusual manifest has landed cost close to retail.
// landedCostPerUnit is null whenever the manifest has no totalLandedCost
// entered yet — floorPrice is null in that case rather than guessed.
export function computeWalkupPrices(
  item: { retailPrice: number; landedCostPerUnit: number | null },
  settings: WalkupSaleSettings
): WalkupPrices {
  const floorPrice =
    item.landedCostPerUnit != null ? item.landedCostPerUnit * (1 + settings.floorMarginPct / 100) : null;
  const rawIdealPrice = item.retailPrice * (settings.idealRetailPct / 100);
  const idealPrice = floorPrice != null ? Math.max(rawIdealPrice, floorPrice) : rawIdealPrice;
  const nearExpiryPrice = item.retailPrice * (settings.nearExpiryRetailPct / 100);
  return { floorPrice, idealPrice, nearExpiryPrice };
}
