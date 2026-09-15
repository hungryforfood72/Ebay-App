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
    scope: SELL_INVENTORY_SCOPE,
    state,
  });
  return `${config.authBase}/oauth2/authorize?${params.toString()}`;
}

type TokenResult = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken?: string;
  refreshTokenExpiresAt?: Date;
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
  };
}

export async function exchangeCodeForToken(code: string): Promise<Required<TokenResult>> {
  const config = getEbayConfig();
  const result = await requestToken(
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri })
  );
  if (!result.refreshToken || !result.refreshTokenExpiresAt) {
    throw new Error("eBay didn't return a refresh token with the authorization code exchange.");
  }
  return result as Required<TokenResult>;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  return requestToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, scope: SELL_INVENTORY_SCOPE })
  );
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
  const refreshed = await refreshAccessToken(token.refreshToken);
  await prisma.ebayAuthToken.update({
    where: { environment },
    data: { accessToken: refreshed.accessToken, accessTokenExpiresAt: refreshed.accessTokenExpiresAt },
  });
  return refreshed.accessToken;
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

// eBay's Inventory API SKU must be alphanumeric only and ≤50 characters —
// stricter than the app's own sku field ("(Location - A3)-<uuid>", used
// freely elsewhere: CSV CustomLabel, on-screen display, internal
// uniqueness). Strips everything else and keeps the last 50 chars rather
// than the first 50, so truncation (for an unusually long shelf location
// label) trims the human-readable prefix instead of the UUID suffix that
// actually guarantees uniqueness. Deterministic and reusable — matching an
// eBay order's SKU back to an Item later just means recomputing this same
// function over each candidate Item.sku, no extra field needed.
export function toEbaySku(sku: string): string {
  const alphanumeric = sku.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumeric.length > 50 ? alphanumeric.slice(-50) : alphanumeric;
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

export async function createOffer(item: ItemForEbayPublish): Promise<string> {
  const config = getEbayConfig();
  const result = (await ebayFetch(`/sell/inventory/v1/offer`, {
    method: "POST",
    body: JSON.stringify({
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
      pricingSummary: { price: { value: item.price.toFixed(2), currency: "USD" } },
      merchantLocationKey: config.merchantLocationKey,
    }),
  })) as { offerId: string };
  return result.offerId;
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

export function listingUrl(environment: string, listingId: string): string {
  return environment === "production"
    ? `https://www.ebay.com/itm/${listingId}`
    : `https://sandbox.ebay.com/itm/${listingId}`;
}
