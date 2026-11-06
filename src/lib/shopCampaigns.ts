import { getShopifyConfig, shopifyGraphql } from "./shopify";

// Shop Campaigns (Shopify's "autopilot" ads, Cristian 2026-11-06): Shop
// charges per sale it brings in, billed on the Shopify bill, never on the
// order itself, so the order sync can't see it. ShopifyQL's
// shop_campaign_insights has the spend by day; the dashboard takes it off
// profit for the range. Needs the read_reports scope (plus the protected
// customer data access the app already has for local delivery).

export type ShopAdSpend = {
  spend: number;
  // What those campaigns sold and how many customers, for a return-on-ad-
  // spend line next to it.
  sales: number;
  customers: number;
  // null when it was read; otherwise why it couldn't be (missing scope,
  // Shopify not set up), so the dashboard can say so instead of a quiet $0.
  error: string | null;
};

const EMPTY: ShopAdSpend = { spend: 0, sales: 0, customers: 0, error: null };
// Before the store existed, so "all time" covers everything.
const EARLIEST_DAY = "2025-01-01";
const CACHE_MS = 5 * 60_000;

let shopTimezone: string | null = null;
const cache = new Map<string, { at: number; value: ShopAdSpend }>();

// ShopifyQL days are the store's days, so the bounds are turned into dates
// in the store's timezone (America/Chicago for this store).
async function timezone(): Promise<string> {
  if (!shopTimezone) {
    const data = await shopifyGraphql<{ shop: { ianaTimezone: string } }>(`{ shop { ianaTimezone } }`);
    shopTimezone = data.shop.ianaTimezone || "America/Chicago";
  }
  return shopTimezone;
}

function dayIn(tz: string, d: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Shop Campaign spend for sales in [from, to) (to exclusive, either open),
// whole store days. Never throws: a failure comes back as `error` with $0.
export async function shopAdSpend(from: Date | null, to: Date | null): Promise<ShopAdSpend> {
  if (!getShopifyConfig()) return EMPTY;
  try {
    const tz = await timezone();
    const since = from ? dayIn(tz, from) : EARLIEST_DAY;
    const until = dayIn(tz, new Date((to ?? new Date()).getTime() - (to ? 1 : 0)));
    if (!DAY.test(since) || !DAY.test(until)) return { ...EMPTY, error: "Couldn't work out the dates for Shop ads." };
    if (until < since) return EMPTY;

    const key = `${since}..${until}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

    const query = `FROM shop_campaign_insights SHOW shop_campaign_ad_spend, shop_campaign_sales, shop_campaign_customers SINCE ${since} UNTIL ${until}`;
    const data = await shopifyGraphql<{
      shopifyqlQuery: { tableData: { rows: Record<string, string | null>[] } | null; parseErrors: string[] };
    }>(`query ShopAds($q: String!) { shopifyqlQuery(query: $q) { tableData { rows } parseErrors } }`, { q: query });
    const result = data.shopifyqlQuery;
    if (result.parseErrors?.length || !result.tableData) {
      return { ...EMPTY, error: `Shopify couldn't read Shop ads: ${result.parseErrors?.join("; ") || "no data"}` };
    }
    const row = result.tableData.rows[0] ?? {};
    const value: ShopAdSpend = {
      spend: Number(row.shop_campaign_ad_spend ?? 0) || 0,
      sales: Number(row.shop_campaign_sales ?? 0) || 0,
      customers: Number(row.shop_campaign_customers ?? 0) || 0,
      error: null,
    };
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
    if (cache.size > 200) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const scope = /access denied|read_reports|scope/i.test(message);
    return {
      ...EMPTY,
      error: scope
        ? "Shop ads aren't counted yet: the app needs the read_reports permission in Shopify."
        : `Couldn't read Shop ads from Shopify: ${message.slice(0, 200)}`,
    };
  }
}
