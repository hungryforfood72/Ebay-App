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
const SELL_MARKETING_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.marketing";
const REQUIRED_SCOPES = [SELL_INVENTORY_SCOPE, SELL_FULFILLMENT_SCOPE, SELL_FINANCES_SCOPE, SELL_MARKETING_SCOPE];

export function getEbayConfig() {
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

// Deliberately NOT part of getEbayConfig() above — that object eagerly
// evaluates every field on every call, including from buildAuthorizeUrl/
// requestToken (the OAuth connect flow itself). The ad campaign can't exist
// until *after* Cristian has connected (its setup script needs a valid
// access token), so folding it into the eager config would make
// reconnecting throw "missing env var" before he ever reaches eBay's
// consent screen. This is called only from createAdByListingId, so it only
// throws when someone actually tries to promote something.
function getAdCampaignId(): string {
  const environment = getEbayEnvironment();
  const prefix = environment === "production" ? "EBAY_PRODUCTION_" : "EBAY_SANDBOX_";
  const value = process.env[`${prefix}AD_CAMPAIGN_ID`];
  if (!value) {
    throw new Error(`Missing env var ${prefix}AD_CAMPAIGN_ID — run scripts/ebay-setup-campaign.ts first.`);
  }
  return value;
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
// Browse API (price research) — a completely separate auth flow from
// everything above: Client Credentials grant, app-level identity, no user
// consent. Reuses the same keyset (clientId/clientSecret) already
// configured for the Sell APIs, just a different grant_type, so no new env
// vars are needed. Cached in EbayAppToken (DB-backed, not in-memory) so it
// survives serverless cold starts.
// ---------------------------------------------------------------------------

const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope";

export async function getAppAccessToken(): Promise<string> {
  const environment = getEbayEnvironment();
  const existing = await prisma.ebayAppToken.findUnique({ where: { environment } });
  if (existing && existing.expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return existing.accessToken;
  }
  const result = await requestToken(new URLSearchParams({ grant_type: "client_credentials", scope: BROWSE_SCOPE }));
  await prisma.ebayAppToken.upsert({
    where: { environment },
    create: { environment, accessToken: result.accessToken, expiresAt: result.accessTokenExpiresAt },
    update: { accessToken: result.accessToken, expiresAt: result.accessTokenExpiresAt },
  });
  return result.accessToken;
}

// price is the item price alone; shippingCost is added on top only when
// the listing has a real FIXED shipping charge (CALCULATED shipping
// depends on the buyer's address, which the API can't resolve without one
// — those comps get shippingCost 0, same as genuinely free shipping,
// since there's no other number to use). totalPrice is what a buyer
// actually pays, and is what comps should be compared/sorted on.
export type ActiveListingComp = { itemId: string; price: number; shippingCost: number; totalPrice: number; title: string };

async function fetchActiveListingComps(
  params: URLSearchParams,
  excludeListingId?: string | null
): Promise<ActiveListingComp[]> {
  const config = getEbayConfig();
  const token = await getAppAccessToken();
  const res = await fetch(`${config.apiBase}/buy/browse/v1/item_summary/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const errors = (body as { errors?: { message: string; longMessage?: string }[] } | null)?.errors;
    throw new EbayApiError(
      errors?.length ? errors.map((e) => e.longMessage ?? e.message).join("; ") : `Browse API error (${res.status})`,
      res.status,
      errors ?? body
    );
  }
  const result = (await res.json()) as {
    itemSummaries?: {
      itemId: string;
      title: string;
      price?: { value: string };
      shippingOptions?: { shippingCostType: string; shippingCost?: { value: string } }[];
    }[];
  };
  return (result.itemSummaries ?? [])
    .filter((i) => i.itemId !== excludeListingId && i.price)
    .map((i) => {
      const price = Number(i.price!.value);
      // Only a FIXED shippingCostType actually carries a shippingCost value
      // — confirmed live. CALCULATED shipping varies by buyer address, so
      // there's no number the API can give without one.
      const shippingOption = i.shippingOptions?.[0];
      const shippingCost =
        shippingOption?.shippingCostType === "FIXED" && shippingOption.shippingCost
          ? Number(shippingOption.shippingCost.value)
          : 0;
      return { itemId: i.itemId, price, shippingCost, totalPrice: price + shippingCost, title: i.title };
    });
}

// GET /buy/browse/v1/item_summary/search — active (not sold) listings, the
// only comp data actually available via API (see EbayApiError's callers
// for the sold-comps research that confirmed Marketplace Insights is
// closed to new applicants). Runs BOTH a GTIN (UPC) search and a keyword
// search when a UPC is available, merged and deduped by itemId — GTIN
// alone is precise but drastically under-samples: confirmed live, a real
// UPC returned only 10 GTIN-tagged comps vs. 1,234 total available via
// keyword search for the same product, because most sellers never fill in
// the UPC field on their listing. Keyword-only (no UPC, e.g. bundles) is
// unchanged.
export async function searchActiveListings(query: {
  upc: string | null;
  keywords: string;
  excludeListingId?: string | null;
}): Promise<ActiveListingComp[]> {
  if (!query.upc) {
    const params = new URLSearchParams({ limit: "50", q: query.keywords });
    return fetchActiveListingComps(params, query.excludeListingId);
  }

  const gtinParams = new URLSearchParams({ limit: "50", gtin: query.upc });
  const keywordParams = new URLSearchParams({ limit: "50", q: query.keywords || query.upc });
  const [gtinComps, keywordComps] = await Promise.all([
    fetchActiveListingComps(gtinParams, query.excludeListingId),
    fetchActiveListingComps(keywordParams, query.excludeListingId),
  ]);
  const merged = new Map<string, ActiveListingComp>();
  for (const c of [...gtinComps, ...keywordComps]) merged.set(c.itemId, c);
  return [...merged.values()];
}

export type LiveListingPrice = { price: number; originalPrice: number | null };

// GET /buy/browse/v1/item/get_item_by_legacy_id — the app's own stored
// Item.price is what it was set to at publish/discount time, but a running
// "Sale event" markdown changes the actual live price on eBay without ever
// writing back to our DB (there's no webhook for it). Confirmed live: the
// top-level `price` is the current (post-markdown) price a buyer pays, and
// `marketingPrice.originalPrice` is only present while a strikethrough sale
// is active — exactly the two numbers needed to show real live state
// instead of a stale one. Uses the app-level Browse API token, same as
// searchActiveListings, since this is public listing data.
export async function getLiveListingPrice(legacyItemId: string): Promise<LiveListingPrice | null> {
  const config = getEbayConfig();
  const token = await getAppAccessToken();
  const res = await fetch(
    `${config.apiBase}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(legacyItemId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "Content-Language": "en-US",
        "Accept-Language": "en-US",
      },
    }
  );
  if (!res.ok) return null; // best-effort — a failed live lookup falls back to the stored price, not an error
  const body = (await res.json()) as {
    price?: { value: string };
    marketingPrice?: { originalPrice?: { value: string } };
  };
  if (!body.price) return null;
  return {
    price: Number(body.price.value),
    originalPrice: body.marketingPrice?.originalPrice ? Number(body.marketingPrice.originalPrice.value) : null,
  };
}

// ---------------------------------------------------------------------------
// Inventory API
// ---------------------------------------------------------------------------

// baseOverride exists for the Finances API, which resolves under a
// different host entirely (apiz.*.ebay.com, not api.*.ebay.com) — every
// other Sell API this app talks to uses config.apiBase, so this defaults
// to that rather than needing every call site to know the difference.
async function ebayFetch(path: string, init: RequestInit = {}, baseOverride?: string): Promise<unknown> {
  const [token, config] = await Promise.all([getValidAccessToken(), Promise.resolve(getEbayConfig())]);
  const res = await fetch(`${baseOverride ?? config.apiBase}${path}`, {
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

// Maps a raw Prisma Item row (or the subset of its fields needed here) into
// the shape createOrReplaceInventoryItem/createOffer/updateOfferPrice
// expect. Used at publish time and by both discount routes (manifest bulk
// and single-item) — priceOverride lets a discount route pass the newly
// computed price without first mutating the DB row.
export function toItemForEbayPublish(
  item: {
    sku: string;
    finalTitle: string | null;
    finalDescription: string | null;
    price: unknown;
    categoryId: string | null;
    condition: string | null;
    itemSpecifics: unknown;
    photoUrls: string[];
    quantity: number;
    weightLbs: number | null;
    weightOz: number | null;
    upc: string | null;
  },
  priceOverride?: number
): ItemForEbayPublish {
  return {
    sku: item.sku,
    finalTitle: item.finalTitle ?? "",
    finalDescription: item.finalDescription ?? "",
    price: priceOverride ?? Number(item.price ?? 0),
    categoryId: item.categoryId ?? "",
    condition: (item.condition ?? "used") as ItemForEbayPublish["condition"],
    itemSpecifics: item.itemSpecifics as Record<string, string> | null,
    photoUrls: item.photoUrls,
    quantity: item.quantity,
    weightLbs: item.weightLbs,
    weightOz: item.weightOz,
    upc: item.upc,
  };
}

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
  title: string;
  quantity: number;
  lineItemCostValue: number; // selling price × quantity for this line — already the full line revenue, not per-unit
};

export type EbayOrder = {
  orderId: string;
  orderPaymentStatus: string;
  creationDate: string;
  lineItems: EbayOrderLineItem[];
};

// GET /sell/fulfillment/v1/order/{orderId} — single-order lookup, used to
// re-derive an order's full line-item list (for proportional shipping
// allocation) without needing a date-range scan.
export async function getOrder(orderId: string): Promise<EbayOrder> {
  const o = (await ebayFetch(`/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`)) as {
    orderId: string;
    orderPaymentStatus: string;
    creationDate: string;
    lineItems?: { lineItemId: string; sku?: string; title?: string; quantity?: number; lineItemCost?: { value: string } }[];
  };
  return {
    orderId: o.orderId,
    orderPaymentStatus: o.orderPaymentStatus,
    creationDate: o.creationDate,
    lineItems: (o.lineItems ?? [])
      .filter((li): li is Required<typeof li> => Boolean(li.sku && li.quantity && li.lineItemCost))
      .map((li) => ({
        lineItemId: li.lineItemId,
        sku: li.sku,
        title: li.title ?? li.sku,
        quantity: li.quantity,
        lineItemCostValue: Number(li.lineItemCost.value),
      })),
  };
}

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
        lineItems?: { lineItemId: string; sku?: string; title?: string; quantity?: number; lineItemCost?: { value: string } }[];
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
            title: li.title ?? li.sku,
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
  lineItemFees: { lineItemId: string; totalFees: number }[];
  // Shipping label cost is its OWN transaction (transactionType
  // SHIPPING_LABEL, a DEBIT), separate from the SALE transaction and not
  // itemized per line item — confirmed live on a real order. Order-level,
  // so the caller allocates it across matched line items itself.
  //
  // Critically, the SAME shipping transaction (same transactionId) can
  // come back for SEVERAL different orderId queries — confirmed live:
  // Cristian combine-ships multiple eBay orders under one physical label,
  // and eBay associates that one label transaction with every order in the
  // shipment. Naively summing shippingLabelCost per order therefore
  // double- (or N-times-) counts the same real cost. The transactionId is
  // exposed here specifically so callers can dedupe globally (e.g. "has
  // this transactionId already been counted on any existing sale row?")
  // rather than trusting a per-order total. Array, not a single value,
  // since an order could in principle have more than one shipping-label
  // transaction (a split shipment).
  shippingLabels: { transactionId: string; amount: number }[];
  // Buyer refunds against this order — confirmed live in two shapes: most
  // have orderLineItems naming which line(s) were refunded (each with its
  // own marketplaceFees, but as CREDITS here rather than charges — and
  // note the API gives no genuine per-line *revenue* breakdown, only a
  // top-level total, even when multiple lines are named), but a Money Back
  // Guarantee case refund can come back with no orderLineItems at all —
  // just a top-level amount, no way to tell which line item it covers.
  // affectedLineItemIds is empty for that second shape; the caller falls
  // back to splitting totalAmount/totalFeeCredit proportionally across
  // whatever of the order's line items it already has a sale on record
  // for (same allocation philosophy as shippingLabels above).
  refunds: {
    transactionId: string;
    refundedAt: string;
    totalAmount: number;
    totalFeeCredit: number;
    affectedLineItemIds: string[];
  }[];
};

// GET /sell/finances/v1/transaction?filter=orderId:{orderId} — the real
// fees (final value fee, regulatory fee, etc.) actually deducted from the
// payout for each line item in this order, plus the order's shipping label
// cost if purchased through eBay. Uses transaction rather than the
// order_earnings resource (GET .../order_earnings/{orderId}, same line-item
// fee data, simpler call) — verified live that order_earnings 403s with
// "Insufficient permissions" even with the sell.finances scope correctly
// granted (it needs some additional eBay-side enrollment this account
// doesn't have), while transaction returns the identical
// orderLineItems[].marketplaceFees[] data with no such restriction. Also
// confirmed live that the Finances API resolves under apiz.*.ebay.com, not
// api.*.ebay.com like every other Sell API this app talks to — a
// wrong-host call here comes back as a bare 404 with an empty body, not an
// eBay error response, easy to mistake for "order not found."
export async function getOrderEarnings(orderId: string): Promise<EbayOrderEarnings> {
  const environment = getEbayEnvironment();
  const financesBase = environment === "production" ? "https://apiz.ebay.com" : "https://apiz.sandbox.ebay.com";
  const result = (await ebayFetch(
    `/sell/finances/v1/transaction?filter=${encodeURIComponent(`orderId:{${orderId}}`)}`,
    {},
    financesBase
  )) as {
    transactions?: {
      transactionType?: string;
      transactionId?: string;
      amount?: { value: string };
      transactionDate?: string;
      orderLineItems?: { lineItemId: string; marketplaceFees?: { amount: { value: string } }[] }[];
    }[];
  };
  const transactions = result.transactions ?? [];

  // Only SALE transactions' orderLineItems represent fees actually
  // charged — a REFUND transaction's orderLineItems.marketplaceFees are
  // CREDITS, and were previously being summed into the same pool as
  // charges here, silently inflating fees on any order with a refund.
  const saleLineItems = transactions.filter((t) => t.transactionType === "SALE").flatMap((t) => t.orderLineItems ?? []);

  const shippingLabels = transactions
    .filter((t) => t.transactionType === "SHIPPING_LABEL" && t.transactionId)
    .map((t) => ({ transactionId: t.transactionId!, amount: Number(t.amount?.value ?? 0) }));

  const refunds = transactions
    .filter((t) => t.transactionType === "REFUND" && t.transactionId)
    .map((t) => ({
      transactionId: t.transactionId!,
      refundedAt: t.transactionDate ?? new Date().toISOString(),
      totalAmount: Number(t.amount?.value ?? 0),
      totalFeeCredit: (t.orderLineItems ?? []).reduce(
        (sum, li) => sum + (li.marketplaceFees ?? []).reduce((s, f) => s + Number(f.amount.value), 0),
        0
      ),
      affectedLineItemIds: (t.orderLineItems ?? []).map((li) => li.lineItemId),
    }));

  return {
    lineItemFees: saleLineItems.map((li) => ({
      lineItemId: li.lineItemId,
      totalFees: (li.marketplaceFees ?? []).reduce((sum, f) => sum + Number(f.amount.value), 0),
    })),
    shippingLabels,
    refunds,
  };
}

// ---------------------------------------------------------------------------
// Marketing API (Promoted Listings — Cost Per Sale funding, so eBay only
// charges the ad fee, as a % of the sale price, if the promoted item
// actually sells; no upfront spend). Request/response shapes per eBay's
// current published docs — not yet exercised against a real call, since no
// campaign exists until scripts/ebay-setup-campaign.ts is run. Fails loud
// (a clear thrown error) rather than silently storing a wrong/undefined id.
// ---------------------------------------------------------------------------

export async function getAdCampaigns(): Promise<{ campaignId: string; campaignName: string; campaignStatus: string }[]> {
  const result = (await ebayFetch(`/sell/marketing/v1/ad_campaign?campaign_statuses=ACTIVE,PAUSED&limit=100`)) as {
    campaigns?: { campaignId: string; campaignName: string; campaignStatus: string }[];
  };
  return result.campaigns ?? [];
}

// One-time setup (see scripts/ebay-setup-campaign.ts) — an ad campaign must
// exist before any item can be promoted into it. No endDate is set, so the
// campaign runs indefinitely rather than needing periodic renewal.
export async function createAdCampaign(name: string, defaultBidPercentage: number): Promise<string> {
  const result = (await ebayFetch(`/sell/marketing/v1/ad_campaign`, {
    method: "POST",
    body: JSON.stringify({
      marketplaceId: "EBAY_US",
      campaignName: name,
      fundingStrategy: {
        fundingModel: "COST_PER_SALE",
        bidPercentage: String(defaultBidPercentage),
      },
      startDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  })) as { campaignId?: string };
  if (!result.campaignId) {
    throw new Error("eBay didn't return a campaignId when creating the ad campaign.");
  }
  return result.campaignId;
}

export async function createAdByListingId(listingId: string, bidPercentage: number): Promise<string> {
  const campaignId = getAdCampaignId();
  const result = (await ebayFetch(`/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad`, {
    method: "POST",
    body: JSON.stringify({ listingId, bidPercentage: String(bidPercentage) }),
  })) as { adId?: string };
  if (!result.adId) {
    throw new Error("eBay didn't return an adId when creating the ad — check the response shape.");
  }
  return result.adId;
}

// Some items already had an active Promoted Listings ad from before this
// app's integration existed (created directly in Seller Hub, or from an
// earlier manual campaign) — createAdByListingId 403s "already exists" for
// those. This looks the existing ad up so the promote route can self-heal
// by linking it instead of just failing.
export async function findAdByListingId(listingId: string): Promise<{ adId: string; bidPercentage: number } | null> {
  const campaignId = getAdCampaignId();
  const result = (await ebayFetch(
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad?listing_ids=${encodeURIComponent(listingId)}`
  )) as { ads?: { adId: string; listingId: string; bidPercentage?: string }[] };
  const ad = result.ads?.find((a) => a.listingId === listingId);
  return ad ? { adId: ad.adId, bidPercentage: Number(ad.bidPercentage ?? 0) } : null;
}

// Path is /update_bid, not just /bid — confirmed live (the latter 404s).
export async function updateAdBid(adId: string, bidPercentage: number): Promise<void> {
  const campaignId = getAdCampaignId();
  await ebayFetch(
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad/${encodeURIComponent(adId)}/update_bid`,
    { method: "POST", body: JSON.stringify({ bidPercentage: String(bidPercentage) }) }
  );
}

// Stops promoting an item (removes it from the campaign) — the listing
// itself stays live, only the ad is deleted.
export async function deleteAd(adId: string): Promise<void> {
  const campaignId = getAdCampaignId();
  await ebayFetch(`/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad/${encodeURIComponent(adId)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Marketing API — "Sale event" (Discounts Manager, formerly Markdown
// Manager). Shows a strikethrough "was $X" price next to the discounted
// price on the live listing, unlike updateOfferPrice which just silently
// changes the price. Field names here (`name`, `selectedInventoryDiscounts`,
// `inventoryCriterion.listingIds`) are confirmed against a real object —
// eBay's own docs for this endpoint 403/404 for WebFetch, and the
// create call 500s with generic "Internal error" on any wrong field name
// with zero useful validation feedback (a publicly reported, still-open
// eBay bug as of 2026-09-15 — see the eBay dev community thread
// "createItemPriceMarkdownPromotion crashing"). Ground truth came from
// GET-ing a sale event created manually in Seller Hub.
// ---------------------------------------------------------------------------

export type MarkdownPromotion = {
  promotionId: string; // "{id}@{marketplace}" composite, as eBay itself addresses it
  percentOff: number;
  startDate: string;
  endDate: string;
};

// createItemPriceMarkdownPromotion returns 201 with an empty body — the new
// promotion's id is only in the Location header, not JSON, so this can't go
// through the shared ebayFetch() (which always calls res.json()).
//
// description and promotionImageUrl are only required once promotionStatus
// is RUNNING (not DRAFT) — confirmed live: a DRAFT create without them
// succeeds, a RUNNING one 400s with "A valid entry is required for
// 'description'/'promotionImageUrl'".
export async function createMarkdownPromotion(
  listingId: string,
  percentOff: number,
  endDate: Date,
  description: string,
  promotionImageUrl: string
): Promise<MarkdownPromotion> {
  const [token, config] = await Promise.all([getValidAccessToken(), Promise.resolve(getEbayConfig())]);
  const startDate = new Date(Date.now() + 60 * 1000); // eBay rejects a startDate that's already in the past by the time it processes the request
  const body = {
    name: `Sale event — ${percentOff}% off`,
    description,
    promotionImageUrl,
    marketplaceId: "EBAY_US",
    promotionStatus: "RUNNING",
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    selectedInventoryDiscounts: [
      {
        discountBenefit: { percentageOffItem: percentOff.toFixed(1) },
        ruleOrder: 0,
        inventoryCriterion: { inventoryCriterionType: "INVENTORY_BY_VALUE", listingIds: [listingId] },
      },
    ],
  };
  const res = await fetch(`${config.apiBase}/sell/marketing/v1/item_price_markdown`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    const errors = (errBody as { errors?: { message: string; longMessage?: string }[] } | null)?.errors;
    const message = errors?.length ? errors.map((e) => e.longMessage ?? e.message).join("; ") : `eBay API error (${res.status})`;
    throw new EbayApiError(message, res.status, errors ?? errBody);
  }
  const location = res.headers.get("Location");
  const promotionId = location?.split("/").pop();
  if (!promotionId) {
    throw new Error("eBay didn't return a promotion id (no Location header) when creating the sale event.");
  }
  return { promotionId, percentOff, startDate: startDate.toISOString(), endDate: endDate.toISOString() };
}

// Ends a sale event early / removes it — the listing itself stays live,
// only the strikethrough markdown is removed. Not routed through the shared
// ebayFetch() — confirmed live that this endpoint returns 200 with an empty
// body (not 204 like deleteAd's ad_campaign endpoint), which ebayFetch's
// unconditional res.json() on any non-204 status would choke on.
export async function deleteMarkdownPromotion(promotionId: string): Promise<void> {
  const [token, config] = await Promise.all([getValidAccessToken(), Promise.resolve(getEbayConfig())]);
  const res = await fetch(`${config.apiBase}/sell/marketing/v1/item_price_markdown/${encodeURIComponent(promotionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Content-Language": "en-US", "Accept-Language": "en-US" },
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    const errors = (errBody as { errors?: { message: string; longMessage?: string }[] } | null)?.errors;
    const message = errors?.length ? errors.map((e) => e.longMessage ?? e.message).join("; ") : `eBay API error (${res.status})`;
    throw new EbayApiError(message, res.status, errors ?? errBody);
  }
}

// ---------------------------------------------------------------------------
// Trading API (legacy XML) — only for listings that were bulk-uploaded via
// the File Exchange CSV export (src/lib/csv.ts), never through this app's
// own Inventory API publish flow. Those have no ebayOfferId (offers are an
// Inventory-API-only concept), so they can't be discounted via
// updateOfferPrice — but their listingId works fine for Promoted Listings
// (createAdByListingId above is confirmed to work on both classic and
// RESTful listings) once it's known. Same OAuth user token works here via
// the X-EBAY-API-IAF-TOKEN header — no separate auth needed.
// ---------------------------------------------------------------------------

async function tradingApiFetch(callName: string, bodyXml: string): Promise<string> {
  const [token, config] = await Promise.all([getValidAccessToken(), Promise.resolve(getEbayConfig())]);
  const res = await fetch(`${config.apiBase}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1439",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-IAF-TOKEN": token,
    },
    body: `<?xml version="1.0" encoding="utf-8"?>${bodyXml}`,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new EbayApiError(`Trading API ${callName} failed (${res.status})`, res.status, text);
  }
  // Trading API always returns HTTP 200 even for application-level errors —
  // the real result is in the XML body's Ack field.
  if (/<Ack>Failure<\/Ack>/.test(text)) {
    const message = text.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1];
    throw new EbayApiError(message ?? `Trading API ${callName} returned Failure`, 200, text);
  }
  return text;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Looks up ItemIDs for a batch of SKUs (our own Item.sku, verbatim — that's
// exactly what csv.ts put in the CustomLabel/SKU field at upload time, no
// transformation). Batches internally since GetSellerList's SKUArray has an
// undocumented-here practical limit — verified batch size against a real
// call rather than assumed.
export async function findListingsBySku(skus: string[], batchSize = 20): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < skus.length; i += batchSize) {
    const batch = skus.slice(i, i + batchSize);
    // GetSellerList's SKUArray entries are capped at 50 chars (the same
    // limit the Inventory API enforces on its own sku field) — File
    // Exchange's CustomLabel column got the full, untruncated app sku
    // (often ~54 chars with the "(Location - X)-" prefix), so eBay's own
    // stored value is presumably truncated the same way. Query truncated,
    // but key the result map by the original full sku so it still matches
    // Item.sku for the DB update.
    const truncated = new Map(batch.map((s) => [s.slice(0, 50), s]));
    const skuArrayXml = [...truncated.keys()].map((s) => `<SKU>${xmlEscape(s)}</SKU>`).join("");
    // GetSellerList requires a start-time window even when filtering by
    // SKUArray — it filters by the listing's *current* cycle start (GTC
    // listings silently renew every ~30 days, shifting this forward), so
    // the widest window eBay allows (120 days) is used rather than trying
    // to predict it from our own exportedAt timestamp.
    const startTimeTo = new Date();
    const startTimeFrom = new Date(startTimeTo.getTime() - 120 * 24 * 60 * 60 * 1000);
    const xml = await tradingApiFetch(
      "GetSellerList",
      `<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents"><SKUArray>${skuArrayXml}</SKUArray><StartTimeFrom>${startTimeFrom.toISOString()}</StartTimeFrom><StartTimeTo>${startTimeTo.toISOString()}</StartTimeTo><DetailLevel>ReturnAll</DetailLevel><GranularityLevel>Fine</GranularityLevel><Pagination><EntriesPerPage>${batchSize}</EntriesPerPage><PageNumber>1</PageNumber></Pagination></GetSellerListRequest>`
    );
    // Split on <Item> boundaries before extracting fields, so a SKU/ItemID
    // pair is always read from within the same <Item> block rather than a
    // global regex potentially pairing fields from different items.
    for (const block of xml.split("<Item>").slice(1)) {
      const itemId = block.match(/<ItemID>(.*?)<\/ItemID>/)?.[1];
      const sku = block.match(/<SKU>(.*?)<\/SKU>/)?.[1];
      const originalSku = sku ? truncated.get(sku) : undefined;
      if (itemId && originalSku) found.set(originalSku, itemId);
    }
  }
  return found;
}

// Price-only revision for a classic (Trading API) listing — unlike the
// Inventory API's updateOffer, this is NOT a full-replace call; only the
// fields included get changed.
export async function reviseFixedPriceItemPrice(itemId: string, newPrice: number): Promise<void> {
  await tradingApiFetch(
    "ReviseFixedPriceItem",
    `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>${xmlEscape(itemId)}</ItemID><StartPrice>${newPrice.toFixed(2)}</StartPrice></Item></ReviseFixedPriceItemRequest>`
  );
}

export function listingUrl(environment: string, listingId: string): string {
  return environment === "production"
    ? `https://www.ebay.com/itm/${listingId}`
    : `https://sandbox.ebay.com/itm/${listingId}`;
}
