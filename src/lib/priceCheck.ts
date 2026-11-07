// "Check the price" on Review (Cristian, 2026-11-06), saved as
// Item.priceCheck. The pack card's researched price was above store retail
// ("above_retail"), or, with no retail on the manifest, more than 2x the
// store-price check ("prices_disagree"). The item still goes on eBay as
// normal; this only reminds him to look at sold comps before publishing.
// Dollars per manifest unit; null where it doesn't apply (and every price
// for an employee, who only gets the flag).
export type PriceCheck = {
  why: "above_retail" | "prices_disagree";
  research: number | null;
  retail: number | null;
  check: number | null;
};

const PRICE_CHECK_WHYS = ["above_retail", "prices_disagree"] as const;

// Which flag the List page's card showed, if any. Only the kind comes from
// the browser; the server looks the prices up itself (priceCheckFigures).
export function parsePriceCheckWhy(v: unknown): PriceCheck["why"] | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const why = (v as Record<string, unknown>).why;
  return PRICE_CHECK_WHYS.find((w) => w === why) ?? null;
}

// A dollar amount to the cent, or null when there's no real one.
export function cents(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const r = Math.round(n * 100) / 100;
  return r >= 0.01 ? r : null;
}

// For an employee: the flag, without the owner's figures.
export function blankPriceCheck(v: unknown): PriceCheck | null {
  const why = parsePriceCheckWhy(v);
  return why ? { why, research: null, retail: null, check: null } : null;
}
