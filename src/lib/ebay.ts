import { prisma } from "./prisma";
import { truncateTitle } from "./ebayTitle";

// Single toggle for which eBay environment the whole app talks to. Flipping
// this (and redeploying) points every OAuth/Inventory API call at Sandbox or
// Production without needing a second deployment — tokens are kept per
// environment (see EbayAuthToken) so switching back doesn't lose either
// connection.
export type EbayEnvironment = "sandbox" | "production";

export function getEbayEnvironment(): EbayEnvironment {
  return process.env.EBAY_ENV === "production" ? "production" : "sandbox";
}

// eBay's OAuth scope URIs are always under api.ebay.com (not api.sandbox...)
// even when requesting a Sandbox token — that's an eBay quirk, not a bug.
const SELL_INVENTORY_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.inventory";
const SELL_FULFILLMENT_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.fulfillment";
const SELL_FINANCES_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.finances";
const REQUIRED_SCOPES = [SELL_INVENTORY_SCOPE, SELL_FULFILLMENT_SCOPE, SELL_FINANCES_SCOPE];

function getEbayConfig() {
  const environment = getEbayEnvironment();
  const prefix = environment === "production" ? "EBAY_PRODUCTION_" : "EBAY_SANDBOX_";
  const get = (name: string): string => {
    const value = process.env[`${prefix}${name}`];
    if (!value) {
      throw new Error(`Missing env var ${prefix}${name} for the eBay ${environment} environment.`);
    }
    return value;
  };
  return {
    environment,
    authBase: environment === "production" ? "https://auth.ebay.com" : "https://auth.sandbox.ebay.com",
    apiBase: environment === "production" ? "https://api.ebay.com" : "https://api.sandbox.ebay.com",
    clientId: get("CLIENT_ID"),
    clientSecret: get("CLIENT_SECRET"),
    redirectUri: get("REDIRECT_URI"),
    merchantLocationKey: get("MERCHANT_LOCATION_KEY"),
    fulfillmentPolicyId: get("FULFILLMENT_POLICY_ID"),
    paymentPolicyId: get("PAYMENT_POLICY_ID"),
    returnPolicyId: get("RETURN_POLICY_ID"),
  };
}

export class EbayApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details: unknown
  ) {
    super(message);
    this.name = "EbayApiError";
  }
}

// ---------------------------------------------------------------------------
// OAuth (Authorization Code Grant — required for sell.inventory; Client
// Credentials can't get user-level consent to write to Cristian's own
// inventory).
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(state: string): string {
  const config = getEbayConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: REQUIRED_SCOPES.join(" "),
    state,
  });
  return `${config.authBase}/oauth2/authorize?${params.toString()}`;
}

type TokenResult = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken?: string;
  refreshTokenExpiresAt?: Date;
  scope?: string;
};

async function requestToken(body: URLSearchParams): Promise<TokenResult> {
  const config = getEbayConfig();
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await fetch(`${config.apiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new EbayApiError(json.error_description ?? `eBay token request failed (${res.status}).`, res.status, json);
  }
  const now = Date.now();
  return {
    accessToken: json.access_token,
    accessTokenExpiresAt: new Date(now + json.expires_in * 1000),
    refreshToken: json.refresh_token,
    refreshTokenExpiresAt: json.refresh_token_expires_in
      ? new Date(now + json.refresh_token_expires_in * 1000)
      : undefined,
    scope: json.scope,
  };
}

export async function exchangeCodeForToken(
  code: string
): Promise<Required<Omit<TokenResult, "scope">> & { scope: string }> {
  const config = getEbayConfig();
  const result = await requestToken(
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri })
  );
  if (!result.refreshToken || !result.refreshTokenExpiresAt) {
    throw new Error("eBay didn't return a refresh token with the authorization code exchange.");
  }
  // eBay's consent screen is all-or-nothing (accept/decline, not a
  // per-scope picker), so if the token response ever omits `scope`,
  // whatever was requested is exactly what was granted.
  return { ...result, scope: result.scope ?? REQUIRED_SCOPES.join(" ") } as Required<Omit<TokenResult, "scope">> & {
    scope: string;
  };
}

// Takes scope explicitly rather than a hardcoded constant — OAuth refresh
// can't widen a token's scope beyond what it was originally issued with. If
// this always requested every currently-required scope, a token issued
// before a new scope existed (like the production row from before this
// feature) would fail to refresh the moment it's near expiry, breaking
// whatever was already working, before there's ever a chance to
// reconnect. getValidAccessToken always passes the scope actually stored
// on that row.
async function refreshAccessToken(refreshToken: string, scope: string): Promise<TokenResult> {
  return requestToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, scope }));
}

// Reads the stored token for the current environment, refreshing it first if
// it's within 5 minutes of expiring. Every Inventory API call goes through
// this — nothing else in the app needs to think about token lifecycle.
async function getValidAccessToken(): Promise<string> {
  const environment = getEbayEnvironment();
  const token = await prisma.ebayAuthToken.findUnique({ where: { environment } });
  if (!token) {
    throw new Error(`No eBay ${environment} connection — connect your eBay account in Settings first.`);
  }
  if (token.accessTokenExpiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return token.accessToken;
  }
  // token.scope is null on a row issued before this field existed — that
  // row was only ever granted sell.inventory, so falling back to it here
  // is correct, not just a safe default.
  const refreshed = await refreshAccessToken(token.refreshToken, token.scope ?? SELL_INVENTORY_SCOPE);
  await prisma.ebayAuthToken.update({
    where: { environment },
    data: { accessToken: refreshed.accessToken, accessTokenExpiresAt: refreshed.accessTokenExpiresAt },
  });
  return refreshed.accessToken;
}

// Which of the required scopes the current environment's connection is
// missing — empty if not connected at all (a different case, handled by
// callers checking `connected` separately) or fully connected.
export async function getMissingScopes(): Promise<string[]> {
  const environment = getEbayEnvironment();
  const token = await prisma.ebayAuthToken.findUnique({ where: { environment } });
  if (!token) return [];
  const granted = token.scope ?? SELL_INVENTORY_SCOPE;
  return REQUIRED_SCOPES.filter((s) => !granted.includes(s));
}

// ---------------------------------------------------------------------------
// Inventory API
// ---------------------------------------------------------------------------

async function ebayFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const [token, config] = await Promise.all([getValidAccessToken(), Promise.resolve(getEbayConfig())]);
  const res = await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const errors = (body as { errors?: { message: string; longMessage?: string }[] } | null)?.errors;
    const message = errors?.length
      ? errors.map((e) => e.longMessage ?? e.message).join("; ")
      : `eBay API error (${res.status})`;
    throw new EbayApiError(message, res.status, errors ?? body);
  }
  if (res.status === 204) return null;
  return res.json();
}

export type ItemForEbayPublish = {
  sku: string;
  finalTitle: string;
  finalDescription: string;
  price: number;
  categoryId: string;
  condition: "new" | "new_other" | "used" | "for_parts";
  itemSpecifics: Record<string, string> | null;
  photoUrls: string[];
  quantity: number;
  weightLbs: number | null;
  weightOz: number | null;
  upc: string | null;
};

// eBay's Inventory API ConditionEnum is a ~14-value set, considerably more
// granular than the app's own 4-value ItemCondition — same lossy mapping
// idea as File Exchange's CONDITION_ID in csv.ts, just different target
// values.
const CONDITION_ENUM: Record<ItemForEbayPublish["condition"], string> = {
  new: "NEW",
  new_other: "NEW_OTHER",
  used: "USED_GOOD",
  for_parts: "FOR_PARTS_OR_NOT_WORKING",
};

// eBay item aspects, one value per name — mirrors the same C: item-specific
// fields csv.ts populates for File Exchange, so a category that needed
// Dosage/Size/Department there needs the same aspect here.
function buildAspects(specifics: Record<string, string> | null): Record<string, string[]> {
  const s = specifics ?? {};
  const aspects: Record<string, string[]> = {};
  const add = (name: string, value?: string) => {
    if (value) aspects[name] = [value];
  };
  add("Brand", s.brand);
  add("Color", s.color);
  add("Type", s.type);
  add("Product", s.product);
  add("Size", s.size);
  add("Department", s.department);
  add("Size Type", s.sizeType);
  add("Volume", s.volume);
  add("Dosage", s.dosage);
  return aspects;
}

// eBay's Inventory API SKU must be ≤50 characters and rejects most
// punctuation — stricter than the app's own sku field ("(Location - A3)-
// <uuid>", used freely elsewhere: CSV CustomLabel, on-screen display,
// internal uniqueness). A single underscore separator between the location
// and the unique id is confirmed accepted by the real API (verified with a
// throwaway test item) and keeps the result readable — "LocationA3_..."
// instead of everything mashed together with no separator at all.
// Lossy/non-reversible (strips punctuation, can truncate a long location
// label) — the publish route persists this output to Item.ebaySku right
// after computing it, so order sync can match an incoming order line
// item's sku back to an Item via an indexed exact lookup instead of trying
// to reverse this function or recompute-and-compare against every Item.
export function toEbaySku(sku: string): string {
  const match = sku.match(/^\(Location - (.+?)\)-(.+)$/);
  if (!match) {
    // Fallback for anything that doesn't match the expected shape — strip
    // to alphanumeric and keep the last 50 chars, so a truncation trims the
    // human-readable prefix rather than the more-unique tail.
    const alphanumeric = sku.replace(/[^a-zA-Z0-9]/g, "");
    return alphanumeric.length > 50 ? alphanumeric.slice(-50) : alphanumeric;
  }
  const [, location, unique] = match;
  const locationPart = `Location${location.replace(/[^a-zA-Z0-9]/g, "")}`;
  const uniquePart = unique.replace(/[^a-zA-Z0-9]/g, "");
  // Budget the location half around however long the unique half turns out
  // to be, so the full unique id — the part that actually guarantees no two
  // items collide — never gets cut off to make room.
  const maxLocationChars = Math.max(0, 49 - uniquePart.length);
  return `${locationPart.slice(0, maxLocationChars)}_${uniquePart}`;
}

export async function createOrReplaceInventoryItem(item: ItemForEbayPublish): Promise<void> {
  const totalWeightLbs = (item.weightLbs ?? 0) + (item.weightOz ?? 0) / 16;
  await ebayFetch(`/sell/inventory/v1/inventory_item/${encodeURIComponent(toEbaySku(item.sku))}`, {
    method: "PUT",
    body: JSON.stringify({
      condition: CONDITION_ENUM[item.condition],
      product: {
        title: truncateTitle(item.finalTitle),
        description: item.finalDescription,
        imageUrls: item.photoUrls.slice(0, 12),
        aspects: buildAspects(item.itemSpecifics),
        ...(item.upc ? { upc: [item.upc] } : {}),
      },
      ...(totalWeightLbs > 0
        ? { packageWeightAndSize: { weight: { value: totalWeightLbs, unit: "POUND" } } }
        : {}),
      availability: { shipToLocationAvailability: { quantity: item.quantity } },
    }),
  });
}

// Shared by createOffer and updateOfferPrice — updateOffer is a full-replace
// endpoint (every field required again, not a partial patch), so a price
// change has to resend the same body shape as creation, just with a new
// price value.
function buildOfferBody(item: ItemForEbayPublish, price: number) {
  const config = getEbayConfig();
  return {
    sku: toEbaySku(item.sku),
    marketplaceId: "EBAY_US",
    format: "FIXED_PRICE",
    availableQuantity: item.quantity,
    categoryId: item.categoryId,
    listingDescription: item.finalDescription,
    listingPolicies: {
      fulfillmentPolicyId: config.fulfillmentPolicyId,
      paymentPolicyId: config.paymentPolicyId,
      returnPolicyId: config.returnPolicyId,
      // Matches the CSV export's BestOfferEnabled=true — fixed-price
      // listings that also take offers, with no auto-accept/auto-decline
      // threshold set. Cristian reviews and accepts/declines/counters
      // each one manually in Seller Hub.
      bestOfferTerms: { bestOfferEnabled: true },
    },
    pricingSummary: { price: { value: price.toFixed(2), currency: "USD" } },
    merchantLocationKey: config.merchantLocationKey,
  };
}

export async function createOffer(item: ItemForEbayPublish): Promise<string> {
  const result = (await ebayFetch(`/sell/inventory/v1/offer`, {
    method: "POST",
    body: JSON.stringify(buildOfferBody(item, item.price)),
  })) as { offerId: string };
  return result.offerId;
}

// eBay's Inventory API has no batch endpoint that fits updating many
// different items' prices at once — bulkUpdatePriceQuantity only batches
// multiple offers of the *same* SKU (e.g. one product listed under several
// offerIds), not many different SKUs. So the bulk-discount feature is just
// this, called once per item — same "sequential, not parallel" shape as
// publishAllToEbay in review/page.tsx.
export async function updateOfferPrice(offerId: string, item: ItemForEbayPublish, newPrice: number): Promise<void> {
  await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
    method: "PUT",
    body: JSON.stringify(buildOfferBody(item, newPrice)),
  });
}

export async function publishOffer(offerId: string): Promise<string> {
  const result = (await ebayFetch(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {
    method: "POST",
  })) as { listingId: string };
  return result.listingId;
}

// One-time setup (see scripts/ebay-setup-location.ts) — createOffer requires
// a merchantLocationKey to already exist; it's a ship-from location, not
// something created per listing. A 409 (already exists) is treated as
// success by the caller, not surfaced here.
export async function createOrUpdateMerchantLocation(postalCode: string): Promise<void> {
  const config = getEbayConfig();
  await ebayFetch(`/sell/inventory/v1/location/${encodeURIComponent(config.merchantLocationKey)}`, {
    method: "POST",
    body: JSON.stringify({
      location: { address: { postalCode, country: "US" } },
      locationTypes: ["WAREHOUSE"],
      name: "Warehouse",
      merchantLocationStatus: "ENABLED",
    }),
  });
}

// ---------------------------------------------------------------------------
// Order sync (Fulfillment API for orders, Finances API for real fees —
// used by src/lib/ebayOrderSync.ts). Field names below are per eBay's
// current published schema, not yet exercised against a real order at the
// time this was written — ebayOrderSync.ts validates shapes defensively
// and records a per-order error rather than guessing if something doesn't
// match, so a wrong assumption here fails loud, not silently wrong.
// ---------------------------------------------------------------------------

export type EbayOrderLineItem = {
  lineItemId: string;
  sku: string;
  quantity: number;
  lineItemCostValue: number; // selling price × quantity for this line — already the full line revenue, not per-unit
};

export type EbayOrder = {
  orderId: string;
  orderPaymentStatus: string;
  creationDate: string;
  lineItems: EbayOrderLineItem[];
};

// Pages through GET /sell/fulfillment/v1/order for orders last-modified in
// [from, to). Vercel Cron's own bearer-token check happens one layer up in
// the route handler — this just does the paging.
export async function getRecentOrders(from: Date, to: Date): Promise<EbayOrder[]> {
  const orders: EbayOrder[] = [];
  const limit = 50;
  let offset = 0;
  const filter = `lastmodifieddate:[${from.toISOString()}..${to.toISOString()}]`;
  for (;;) {
    const page = (await ebayFetch(
      `/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=${limit}&offset=${offset}`
    )) as {
      orders?: {
        orderId: string;
        orderPaymentStatus: string;
        creationDate: string;
        lineItems?: { lineItemId: string; sku?: string; quantity?: number; lineItemCost?: { value: string } }[];
      }[];
      total?: number;
    };
    const pageOrders = page.orders ?? [];
    for (const o of pageOrders) {
      orders.push({
        orderId: o.orderId,
        orderPaymentStatus: o.orderPaymentStatus,
        creationDate: o.creationDate,
        lineItems: (o.lineItems ?? [])
          .filter((li): li is Required<typeof li> => Boolean(li.sku && li.quantity && li.lineItemCost))
          .map((li) => ({
            lineItemId: li.lineItemId,
            sku: li.sku,
            quantity: li.quantity,
            lineItemCostValue: Number(li.lineItemCost.value),
          })),
      });
    }
    offset += limit;
    if (pageOrders.length < limit || (page.total != null && offset >= page.total)) break;
  }
  return orders;
}

export type EbayOrderEarnings = {
  lineItemId: string;
  totalFees: number;
}[];

// GET /sell/finances/v1/order_earnings/{orderId} — the real fees (final
// value fee, regulatory fee, shipping label cost if purchased through
// eBay, etc.) actually deducted from the payout for each line item in this
// order.
export async function getOrderEarnings(orderId: string): Promise<EbayOrderEarnings> {
  const result = (await ebayFetch(`/sell/finances/v1/order_earnings/${encodeURIComponent(orderId)}`)) as {
    orderLineItems?: { lineItemId: string; marketplaceFees?: { amount: { value: string } }[] }[];
  };
  return (result.orderLineItems ?? []).map((li) => ({
    lineItemId: li.lineItemId,
    totalFees: (li.marketplaceFees ?? []).reduce((sum, f) => sum + Number(f.amount.value), 0),
  }));
}

export function listingUrl(environment: string, listingId: string): string {
  return environment === "production"
    ? `https://www.ebay.com/itm/${listingId}`
    : `https://sandbox.ebay.com/itm/${listingId}`;
}
