import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { prisma } from "./prisma";

// Shopify Admin GraphQL API for the store that sells this inventory
// alongside eBay (Whatnot reads from it too, through Whatnot's own Shopify
// app). Talks to a Dev Dashboard app installed on that store, using the
// client credentials grant: no static token exists for these apps any more.
// Every call in this app goes through shopifyGraphql below.
export const SHOPIFY_API_VERSION = "2026-10";

// What the app has to be granted on the Dev Dashboard. A write scope
// covers its read scope, so read_x is satisfied by either one.
export const SHOPIFY_REQUIRED_SCOPES = [
  "write_products",
  "write_inventory",
  "read_orders",
  "read_locations",
  "write_publications",
];

export type ShopifyConfig = { shop: string; clientId: string; clientSecret: string };

// null until all three env vars are set, so the rest of the app can treat
// "Shopify isn't set up yet" as a quiet no-op instead of an error.
export function getShopifyConfig(): ShopifyConfig | null {
  const shop = process.env.SHOPIFY_STORE_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!shop || !clientId || !clientSecret) return null;
  return { shop, clientId, clientSecret };
}

export function missingShopifyEnvVars(): string[] {
  return ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"].filter((n) => !process.env[n]?.trim());
}

function requireConfig(): ShopifyConfig {
  const config = getShopifyConfig();
  if (!config) throw new ShopifyApiError(`Shopify isn't set up: missing ${missingShopifyEnvVars().join(", ")}.`);
  return config;
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    public details?: unknown,
    public code?: string
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function getAccessToken(forceNew = false): Promise<string> {
  const config = requireConfig();
  if (!forceNew) {
    const cached = await prisma.shopifyAppToken.findUnique({ where: { shop: config.shop } });
    if (cached && cached.expiresAt.getTime() - Date.now() > 10 * 60 * 1000) return cached.accessToken;
  }
  const res = await fetch(`https://${config.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: { access_token?: string; expires_in?: number; error_description?: string; error?: string } = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Shopify answers a bad shop domain with an HTML page.
  }
  if (!res.ok || !json.access_token) {
    throw new ShopifyApiError(
      `Shopify sign-in failed (${res.status}): ${json.error_description ?? json.error ?? text.slice(0, 200)}`
    );
  }
  const expiresAt = new Date(Date.now() + (json.expires_in ?? 86_399) * 1000);
  await prisma.shopifyAppToken.upsert({
    where: { shop: config.shop },
    create: { shop: config.shop, accessToken: json.access_token, expiresAt },
    update: { accessToken: json.access_token, expiresAt },
  });
  return json.access_token;
}

type GraphqlError = { message: string; extensions?: { code?: string } };

// Retries Shopify's rate-limit answer (THROTTLED) and a revoked/expired
// token once each; anything else throws.
export async function shopifyGraphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const config = requireConfig();
  let token = await getAccessToken();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${config.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && attempt === 0) {
      token = await getAccessToken(true);
      continue;
    }
    const json = (await res.json().catch(() => null)) as { data?: T; errors?: GraphqlError[] | string } | null;
    const errors = Array.isArray(json?.errors) ? json.errors : json?.errors ? [{ message: String(json.errors) }] : [];
    const throttled = res.status === 429 || errors.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok || errors.length > 0 || !json?.data) {
      const message = errors.length ? errors.map((e) => e.message).join("; ") : `Shopify API error (${res.status})`;
      throw new ShopifyApiError(message, json);
    }
    return json.data;
  }
}

type UserError = { field?: string[] | null; message: string; code?: string | null };

function throwOnUserErrors(what: string, userErrors: UserError[] | undefined) {
  if (userErrors && userErrors.length > 0) {
    throw new ShopifyApiError(`${what}: ${userErrors.map((e) => e.message).join("; ")}`, userErrors, userErrors[0].code ?? undefined);
  }
}

// Webhook deliveries are signed with the app's client secret: base64
// HMAC-SHA256 of the raw body, in X-Shopify-Hmac-Sha256.
export function verifyShopifyWebhook(rawBody: string, hmacHeader: string | null): boolean {
  const config = getShopifyConfig();
  if (!config || !hmacHeader) return false;
  const expected = createHmac("sha256", config.clientSecret).update(rawBody, "utf8").digest();
  const given = Buffer.from(hmacHeader, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// Store info
// ---------------------------------------------------------------------------

export async function getShopInfo(): Promise<{ name: string; domain: string; grantedScopes: string[] }> {
  const data = await shopifyGraphql<{
    shop: { name: string; myshopifyDomain: string };
    currentAppInstallation: { accessScopes: { handle: string }[] };
  }>(`{ shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`);
  return {
    name: data.shop.name,
    domain: data.shop.myshopifyDomain,
    grantedScopes: data.currentAppInstallation.accessScopes.map((s) => s.handle),
  };
}

export function missingShopifyScopes(granted: string[]): string[] {
  return SHOPIFY_REQUIRED_SCOPES.filter((scope) => {
    if (granted.includes(scope)) return false;
    return !(scope.startsWith("read_") && granted.includes(scope.replace(/^read_/, "write_")));
  });
}

const LOCATION_KEY = "shopify.locationId";

// The one location stock is kept at: the first active location that
// fulfills online orders. Cached, since it doesn't change.
export async function getLocation(): Promise<{ id: string; name: string }> {
  const cached = await prisma.appSetting.findUnique({ where: { key: LOCATION_KEY } });
  if (cached?.value) {
    const [id, ...name] = cached.value.split("|");
    return { id, name: name.join("|") };
  }
  const data = await shopifyGraphql<{
    locations: { nodes: { id: string; name: string; isActive: boolean; fulfillsOnlineOrders: boolean }[] };
  }>(`{ locations(first: 20) { nodes { id name isActive fulfillsOnlineOrders } } }`);
  const active = data.locations.nodes.filter((l) => l.isActive);
  const location = active.find((l) => l.fulfillsOnlineOrders) ?? active[0];
  if (!location) throw new ShopifyApiError("The Shopify store has no active location to keep stock at.");
  await prisma.appSetting.upsert({
    where: { key: LOCATION_KEY },
    create: { key: LOCATION_KEY, value: `${location.id}|${location.name}` },
    update: { value: `${location.id}|${location.name}` },
  });
  return { id: location.id, name: location.name };
}

// Every sales channel on the store (Online Store, Whatnot, Shop, ...).
// Not cached: a channel added later should start getting new products.
export async function getPublications(): Promise<{ id: string; name: string }[]> {
  const data = await shopifyGraphql<{ publications: { nodes: { id: string; catalog: { title: string } | null }[] } }>(
    `{ publications(first: 50) { nodes { id catalog { title } } } }`
  );
  // Catalog titles read like "Channel Catalog 270568685938 for Whatnot";
  // the channel's own name is the part after "for".
  return data.publications.nodes.map((p) => ({
    id: p.id,
    name: (p.catalog?.title ?? "Sales channel").replace(/^Channel Catalog \d+ for /, ""),
  }));
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export type ShopifyProductRefs = { productId: string; variantId: string; inventoryItemId: string };

type ProductNode = { id: string; variants: { nodes: { id: string; inventoryItem: { id: string } }[] } } | null;

function refsFrom(product: ProductNode): ShopifyProductRefs | null {
  const variant = product?.variants.nodes[0];
  return product && variant ? { productId: product.id, variantId: variant.id, inventoryItemId: variant.inventoryItem.id } : null;
}

export async function findProductByHandle(handle: string): Promise<ShopifyProductRefs | null> {
  const data = await shopifyGraphql<{ productByIdentifier: ProductNode }>(
    `query($identifier: ProductIdentifierInput!) {
      productByIdentifier(identifier: $identifier) { id variants(first: 1) { nodes { id inventoryItem { id } } } }
    }`,
    { identifier: { handle } }
  );
  return refsFrom(data.productByIdentifier);
}

export type NewShopifyProduct = {
  handle: string;
  title: string;
  descriptionHtml: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  photoUrls: string[];
  price: number;
  sku: string;
  barcode: string | null;
  weightLbs: number | null;
  quantity: number;
  locationId: string;
};

// A single-variant product, live (ACTIVE) with its stock at the one
// location. Inventory is tracked and can't oversell (DENY): selling the
// last unit drops it to sold out on every channel at once.
export async function createProduct(p: NewShopifyProduct): Promise<ShopifyProductRefs> {
  const data = await shopifyGraphql<{ productSet: { product: ProductNode; userErrors: UserError[] } }>(
    `mutation($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
        userErrors { field message code }
      }
    }`,
    {
      input: {
        handle: p.handle,
        title: p.title,
        descriptionHtml: p.descriptionHtml,
        ...(p.vendor ? { vendor: p.vendor } : {}),
        ...(p.productType ? { productType: p.productType } : {}),
        tags: p.tags,
        status: "ACTIVE",
        files: p.photoUrls.slice(0, 10).map((url) => ({ originalSource: url, contentType: "IMAGE", alt: p.title })),
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [
          {
            optionValues: [{ optionName: "Title", name: "Default Title" }],
            price: p.price.toFixed(2),
            sku: p.sku,
            ...(p.barcode ? { barcodes: [{ value: p.barcode }] } : {}),
            inventoryPolicy: "DENY",
            inventoryItem: {
              tracked: true,
              requiresShipping: true,
              ...(p.weightLbs && p.weightLbs > 0
                ? { measurement: { weight: { value: Math.round(p.weightLbs * 1000) / 1000, unit: "POUNDS" } } }
                : {}),
            },
            inventoryQuantities: [{ locationId: p.locationId, name: "available", quantity: p.quantity }],
          },
        ],
      },
    }
  );
  throwOnUserErrors("Shopify rejected the product", data.productSet.userErrors);
  const refs = refsFrom(data.productSet.product);
  if (!refs) throw new ShopifyApiError("Shopify created the product but didn't return its variant.");
  return refs;
}

// Publishing to a channel the product is already on is a no-op, so this is
// safe to repeat.
export async function publishToChannels(productId: string, publicationIds: string[]): Promise<void> {
  if (publicationIds.length === 0) return;
  const data = await shopifyGraphql<{ publishablePublish: { userErrors: UserError[] } }>(
    `mutation($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } }
    }`,
    { id: productId, input: publicationIds.map((publicationId) => ({ publicationId })) }
  );
  throwOnUserErrors("Couldn't publish to Shopify's sales channels", data.publishablePublish.userErrors);
}

// Takes a product off some channels and leaves it on the rest. A no-op
// for a channel it isn't on.
export async function unpublishFromChannels(productId: string, publicationIds: string[]): Promise<void> {
  if (publicationIds.length === 0) return;
  const data = await shopifyGraphql<{ publishableUnpublish: { userErrors: UserError[] } }>(
    `mutation($id: ID!, $input: [PublicationInput!]!) {
      publishableUnpublish(id: $id, input: $input) { userErrors { field message } }
    }`,
    { id: productId, input: publicationIds.map((publicationId) => ({ publicationId })) }
  );
  throwOnUserErrors("Couldn't take it off a sales channel", data.publishableUnpublish.userErrors);
}

// compareAt: the struck-through "was" price, or null for none.
export async function updateVariantPrice(
  productId: string,
  variantId: string,
  price: number,
  compareAt: number | null
): Promise<void> {
  const data = await shopifyGraphql<{ productVariantsBulkUpdate: { userErrors: UserError[] } }>(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId, variants: [{ id: variantId, price: price.toFixed(2), compareAtPrice: compareAt != null ? compareAt.toFixed(2) : null }] }
  );
  throwOnUserErrors("Couldn't update the Shopify price", data.productVariantsBulkUpdate.userErrors);
}

export async function addTags(productId: string, tags: string[]): Promise<void> {
  const data = await shopifyGraphql<{ tagsAdd: { userErrors: UserError[] } }>(
    `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
    { id: productId, tags }
  );
  throwOnUserErrors("Couldn't tag the Shopify product", data.tagsAdd.userErrors);
}

export async function updateDescription(productId: string, descriptionHtml: string): Promise<void> {
  const data = await shopifyGraphql<{ productUpdate: { userErrors: UserError[] } }>(
    `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }`,
    { product: { id: productId, descriptionHtml } }
  );
  throwOnUserErrors("Couldn't update the Shopify description", data.productUpdate.userErrors);
}

// A smart collection of every product with `tag`, shown with the theme's
// collection.<templateSuffix> template, on the Online Store only. Found by
// handle first, so it's made once.
export async function ensureTagCollection(input: {
  handle: string;
  title: string;
  tag: string;
  templateSuffix: string;
  descriptionHtml: string;
  publicationIds: string[];
}): Promise<string> {
  const found = await shopifyGraphql<{ collectionByIdentifier: { id: string } | null }>(
    `query($identifier: CollectionIdentifierInput!) { collectionByIdentifier(identifier: $identifier) { id } }`,
    { identifier: { handle: input.handle } }
  );
  if (found.collectionByIdentifier) return found.collectionByIdentifier.id;
  const data = await shopifyGraphql<{ collectionCreate: { collection: { id: string } | null; userErrors: UserError[] } }>(
    `mutation($input: CollectionInput!) {
      collectionCreate(input: $input) { collection { id } userErrors { field message } }
    }`,
    {
      input: {
        handle: input.handle,
        title: input.title,
        descriptionHtml: input.descriptionHtml,
        templateSuffix: input.templateSuffix,
        sortOrder: "CREATED_DESC",
        ruleSet: { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: input.tag }] },
      },
    }
  );
  throwOnUserErrors("Couldn't create the collection", data.collectionCreate.userErrors);
  const id = data.collectionCreate.collection!.id;
  await publishToChannels(id, input.publicationIds);
  return id;
}

// Takes it off every sales channel (Whatnot included) but keeps it, and
// its orders, in the admin.
export async function archiveProduct(productId: string): Promise<void> {
  const data = await shopifyGraphql<{ productUpdate: { userErrors: UserError[] } }>(
    `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }`,
    { product: { id: productId, status: "ARCHIVED" } }
  );
  throwOnUserErrors("Couldn't archive the Shopify product", data.productUpdate.userErrors);
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type ShopifyStockState = {
  // null when the item isn't stocked at the location at all
  available: number | null;
  price: number | null;
  compareAtPrice: number | null;
  productStatus: string | null;
  // Whether it's on the channel passed as checkPublicationId (null when
  // none was passed).
  onCheckedChannel: boolean | null;
};

// Current available count and price for many inventory items at once,
// and optionally whether each is on one sales channel. Items missing from
// the result no longer exist on Shopify (deleted there).
export async function readStock(
  inventoryItemIds: string[],
  locationId: string,
  checkPublicationId?: string
): Promise<Map<string, ShopifyStockState>> {
  const result = new Map<string, ShopifyStockState>();
  const channelField = checkPublicationId ? "publishedOnPublication(publicationId: $publicationId)" : "";
  const channelVar = checkPublicationId ? ", $publicationId: ID!" : "";
  for (let i = 0; i < inventoryItemIds.length; i += 50) {
    const ids = inventoryItemIds.slice(i, i + 50);
    const data = await shopifyGraphql<{
      nodes: ({
        id: string;
        inventoryLevel: { quantities: { name: string; quantity: number }[] } | null;
        variant: {
          price: string;
          compareAtPrice: string | null;
          product: { status: string; publishedOnPublication?: boolean };
        } | null;
      } | null)[];
    }>(
      `query($ids: [ID!]!, $locationId: ID!${channelVar}) {
        nodes(ids: $ids) {
          ... on InventoryItem {
            id
            inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { name quantity } }
            variant { price compareAtPrice product { status ${channelField} } }
          }
        }
      }`,
      { ids, locationId, ...(checkPublicationId ? { publicationId: checkPublicationId } : {}) }
    );
    for (const node of data.nodes) {
      if (!node?.id) continue;
      result.set(node.id, {
        available: node.inventoryLevel?.quantities.find((q) => q.name === "available")?.quantity ?? null,
        price: node.variant ? Number(node.variant.price) : null,
        compareAtPrice: node.variant?.compareAtPrice != null ? Number(node.variant.compareAtPrice) : null,
        productStatus: node.variant?.product.status ?? null,
        onCheckedChannel: node.variant?.product.publishedOnPublication ?? null,
      });
    }
  }
  return result;
}

// Sets the available count only if Shopify still has `expected` (Shopify's
// compare-and-swap, changeFromQuantity). "stale" means it changed since it
// was read, almost always a sale; the caller leaves it for the next run
// rather than overwrite a count it hasn't seen.
export async function setAvailable(
  inventoryItemId: string,
  locationId: string,
  quantity: number,
  expected: number
): Promise<"ok" | "stale"> {
  const data = await shopifyGraphql<{ inventorySetQuantities: { userErrors: UserError[] } }>(
    `mutation($input: InventorySetQuantitiesInput!, $key: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { code field message } }
    }`,
    {
      key: randomUUID(),
      input: {
        name: "available",
        reason: "correction",
        quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: expected }],
      },
    }
  );
  const errors = data.inventorySetQuantities.userErrors;
  if (errors.some((e) => e.code === "CHANGE_FROM_QUANTITY_STALE")) return "stale";
  throwOnUserErrors("Couldn't set the Shopify stock", errors);
  return "ok";
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type ShopifyOrder = {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  sourceName: string | null;
  appName: string | null;
  lineItems: { id: string; quantity: number; variantId: string | null; unitPrice: number }[];
  // Shopify Payments fees on successful sale/capture transactions. Other
  // gateways (and Whatnot, which takes payment itself) report none.
  paymentFees: number;
  refunds: { id: string; createdAt: string; lines: { lineItemId: string; amount: number }[] }[];
};

type Money = { shopMoney: { amount: string } };

// Orders created or changed since `since`, oldest change first. Includes
// orders whose payment is still pending: Shopify takes the stock the
// moment the order exists, so this app has to count it then too.
export async function getOrdersUpdatedSince(since: Date): Promise<ShopifyOrder[]> {
  const orders: ShopifyOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          name: string;
          createdAt: string;
          cancelledAt: string | null;
          sourceName: string | null;
          app: { name: string } | null;
          lineItems: {
            nodes: { id: string; quantity: number; variant: { id: string } | null; discountedUnitPriceAfterAllDiscountsSet: Money }[];
          };
          transactions: { kind: string; status: string; fees: { amount: { amount: string } }[] }[];
          refunds: {
            id: string;
            createdAt: string;
            refundLineItems: { nodes: { lineItem: { id: string }; subtotalSet: Money }[] };
          }[];
        }[];
      };
    } = await shopifyGraphql(
      `query($query: String!, $after: String) {
        orders(first: 25, after: $after, query: $query, sortKey: UPDATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id name createdAt cancelledAt sourceName
            app { name }
            lineItems(first: 100) {
              nodes { id quantity variant { id } discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } }
            }
            transactions(first: 20) { kind status fees { amount { amount } } }
            refunds(first: 20) {
              id createdAt
              refundLineItems(first: 100) { nodes { lineItem { id } subtotalSet { shopMoney { amount } } } }
            }
          }
        }
      }`,
      { query: `updated_at:>='${since.toISOString()}'`, after }
    );
    for (const o of data.orders.nodes) {
      orders.push({
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        cancelledAt: o.cancelledAt,
        sourceName: o.sourceName,
        appName: o.app?.name ?? null,
        lineItems: o.lineItems.nodes.map((li) => ({
          id: li.id,
          quantity: li.quantity,
          variantId: li.variant?.id ?? null,
          unitPrice: Number(li.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount),
        })),
        paymentFees: o.transactions
          .filter((t) => t.status === "SUCCESS" && (t.kind === "SALE" || t.kind === "CAPTURE"))
          .reduce((sum, t) => sum + t.fees.reduce((s, f) => s + Number(f.amount.amount), 0), 0),
        refunds: o.refunds.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          lines: r.refundLineItems.nodes.map((rli) => ({
            lineItemId: rli.lineItem.id,
            amount: Number(rli.subtotalSet.shopMoney.amount),
          })),
        })),
      });
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

// Any order event just wakes the order sync, which reads the orders from
// the API itself, so these three cover everything that changes stock or
// money: a new order, a cancellation, a refund.
export const SHOPIFY_WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_CANCELLED", "REFUNDS_CREATE"];

export async function listWebhooks(): Promise<{ id: string; topic: string; uri: string }[]> {
  const data = await shopifyGraphql<{ webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[] } }>(
    `{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }`
  );
  return data.webhookSubscriptions.nodes;
}

export async function createWebhook(topic: string, uri: string): Promise<void> {
  const data = await shopifyGraphql<{ webhookSubscriptionCreate: { userErrors: UserError[] } }>(
    `mutation($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) { userErrors { field message } }
    }`,
    { topic, webhookSubscription: { uri } }
  );
  throwOnUserErrors(`Couldn't set up the ${topic} webhook`, data.webhookSubscriptionCreate.userErrors);
}
