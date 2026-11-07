import { createHmac, timingSafeEqual } from "node:crypto";

// Whatnot's Seller API (REST, v2; developers.whatnot.com, read 2026-11-06).
// A personal access token from the Whatnot developer dashboard
// (WHATNOT_API_TOKEN, wn_pat_tk_..., set by Cristian in Vercel) with read
// and write inventory, merchandising, orders and shipments, read shows and
// reports. 10 requests a second per seller per app; batch endpoints take 10
// items. No sandbox: every call is on the real account.

const BASE = "https://api.whatnot.com/seller-api/rest/v2";

export function whatnotConfigured(): boolean {
  return Boolean(process.env.WHATNOT_API_TOKEN);
}

export class WhatnotError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown
  ) {
    super(message);
  }
}

// Spacing between calls so a long run stays under 10 a second.
let lastCallAt = 0;
const MIN_GAP_MS = 120;

// Whatnot ids go into URL paths: plain id characters only (no "..").
function id(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new WhatnotError(`Not a Whatnot id: ${value.slice(0, 40)}`, 0, null);
  return value;
}

async function call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = process.env.WHATNOT_API_TOKEN;
  if (!token) throw new WhatnotError("Whatnot isn't connected yet (no API token).", 0, null);
  for (let attempt = 1; ; attempt++) {
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const ms = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt) + Math.random() * 300;
      await new Promise((r) => setTimeout(r, ms));
      continue;
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    // Multi-status (inventory batches): per-item results in the body.
    if (res.ok || res.status === 207) return json as T;
    throw new WhatnotError(`Whatnot ${method} ${path.split("?")[0]} failed (${res.status}): ${describeError(json)}`, res.status, json);
  }
}

function describeError(json: unknown): string {
  if (!json || typeof json !== "object") return String(json ?? "no details").slice(0, 400);
  const o = json as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ["title", "detail", "message", "error"]) if (typeof o[k] === "string") parts.push(o[k] as string);
  if (Array.isArray(o.errors)) {
    for (const e of o.errors.slice(0, 8)) {
      if (e && typeof e === "object") {
        const er = e as Record<string, unknown>;
        parts.push([er.field ?? er.pointer ?? er.loc, er.message ?? er.detail ?? er.msg].filter(Boolean).join(": "));
      } else parts.push(String(e));
    }
  }
  return (parts.join("; ") || JSON.stringify(json)).slice(0, 600);
}

export type Money = { amount: string; currency: string };
// Whatnot takes whole dollars only ("amount must be a whole number of USD",
// first live run 2026-11-06): the sync rounds before it gets here.
export const usd = (n: number): Money => ({ amount: Number.isInteger(n) ? String(n) : n.toFixed(2), currency: "USD" });

export type WhatnotProduct = {
  id: string;
  title: string;
  description: string | null;
  external_id: string | null;
  url?: string | null;
  category: { id: string; name: string | null };
  attributes?: { id: string; name: string | null; value: string }[];
  media?: { id: string | null; url: string }[];
};

export type WhatnotVariant = {
  id: string;
  product_id: string;
  sku: string | null;
  external_id: string | null;
  price: Money | null;
  inventory: { available_quantity: number };
};

export type WhatnotShow = {
  id: string;
  title: string;
  url: string;
  status: "scheduled" | "live" | "stopped" | "ended" | "cancelled";
  scheduled_start_at: string | null;
  ended_at: string | null;
};

export type WhatnotOrder = {
  id: string;
  status: string;
  show_id: string | null;
  transaction_type: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  amounts?: { subtotal?: Money | null; shipping?: Money | null; total?: Money | null } | null;
  // The order in the seller dashboard.
  url?: string | null;
  // Needs read:customers; null without it.
  buyer?: { id: string; username: string; display_name: string | null } | null;
};

export type WhatnotShipment = {
  id: string;
  status: string;
  fulfillment_method: "shipping" | "pickup";
  required_actions?: string[];
  created_at?: string | null;
  // Needs read:customers; null without it.
  recipient?: { id: string; username: string; display_name: string | null } | null;
  tracking?: { carrier?: string | null; tracking_code?: string | null } | null;
  // label_url = the label (from the label provider); bundled_url = label
  // plus packing slip, or the pickup slip (presigned, about an hour). Needs
  // read:customers; null without it.
  documents?: { label_url?: string | null; bundled_url?: string | null } | null;
  // After Whatnot re-bundles or splits it, the shipment that took its items.
  replacement_shipment_id?: string | null;
};

export type WhatnotShipmentItem = {
  id: string;
  shipment_id: string;
  order_id: string | null;
  order_item_id: string | null;
};

export type WhatnotOrderItem = {
  id: string;
  order_id: string;
  product_id: string | null;
  variant_id: string | null;
  product_external_id: string | null;
  variant_external_id: string | null;
  purchased_item: { title: string; sku: string | null } | null;
  quantity: number;
  unit_price: Money;
  // Orders from one buyer that go in one box share a shipment.
  shipment_id?: string | null;
};

type Page<T> = { data: T[]; next_cursor?: string | null; cursor?: string | null; has_more?: boolean };

function pageItems<T>(page: Page<T> | T[]): { items: T[]; next: string | null } {
  if (Array.isArray(page)) return { items: page, next: null };
  return { items: page.data ?? [], next: page.next_cursor ?? null };
}

export async function getMe(): Promise<Record<string, unknown>> {
  return call("GET", "/users/me");
}

export async function listProducts(cursor?: string): Promise<{ items: WhatnotProduct[]; next: string | null }> {
  return pageItems(await call<Page<WhatnotProduct>>("GET", `/products?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
}

export async function createProduct(input: {
  title: string;
  description: string;
  externalId: string;
  categoryId: string;
  imageUrls: string[];
  weightOz: number;
  // Inches; null = weight only.
  dimensions: { length: number; width: number; height: number } | null;
}): Promise<WhatnotProduct> {
  return call("POST", "/products", {
    title: input.title,
    description: input.description,
    external_id: input.externalId,
    category: { id: input.categoryId },
    media: input.imageUrls.map((url) => ({ url })),
    dimension_profile: {
      name: "App",
      weight: { value: Math.max(0.1, Math.round(input.weightOz * 10) / 10), unit: "ounce" },
      ...(input.dimensions ? { dimensions: { ...input.dimensions, unit: "inch" } } : {}),
    },
  });
}

export async function deleteProduct(productId: string): Promise<void> {
  await call("DELETE", `/products/${id(productId)}`);
}

export async function listVariants(productId: string): Promise<WhatnotVariant[]> {
  return pageItems(await call<Page<WhatnotVariant>>("GET", `/products/${id(productId)}/variants`)).items;
}

// Price applies under the product's sale format (auction start price or
// buy-it-now price).
export async function updateVariant(productId: string, variant: { id: string; sku?: string; externalId?: string; price?: number }): Promise<void> {
  await call("PATCH", `/products/${id(productId)}/variants`, {
    variants: [
      {
        id: variant.id,
        ...(variant.sku != null ? { sku: variant.sku } : {}),
        ...(variant.externalId != null ? { external_id: variant.externalId } : {}),
        ...(variant.price != null ? { price: usd(variant.price) } : {}),
      },
    ],
    allow_partial_updates: false,
  });
}

type InventoryResult = { variant_id: string; status: string; new_quantity?: number | null; previous_quantity?: number | null };

// Absolute count. idempotencyKey makes a retried call apply at most once.
export async function setInventory(variantId: string, quantity: number, idempotencyKey: string): Promise<InventoryResult | null> {
  const res = await call<{ results?: InventoryResult[]; items?: InventoryResult[] }>("POST", "/inventory/set", {
    items: [{ variant_id: variantId, quantity: Math.max(0, quantity), idempotency_key: idempotencyKey }],
  });
  const row = (res?.results ?? res?.items ?? [])[0] ?? null;
  if (row && !/^(applied|already_applied|ok|success)/i.test(row.status)) {
    throw new WhatnotError(`Whatnot didn't set the count: ${JSON.stringify(row).slice(0, 300)}`, 207, res);
  }
  return row;
}

// Relative change (floored at 0 by Whatnot), so a Whatnot sale that just
// happened isn't overwritten the way an absolute set would.
export async function adjustInventory(variantId: string, delta: number, idempotencyKey: string): Promise<InventoryResult | null> {
  const res = await call<{ results?: InventoryResult[] }>("POST", "/inventory/adjust", {
    items: [{ variant_id: variantId, delta, idempotency_key: idempotencyKey }],
  });
  const row = (res?.results ?? [])[0] ?? null;
  if (row && !/^(applied|already_applied)$/i.test(row.status)) {
    throw new WhatnotError(`Whatnot didn't change the count: ${JSON.stringify(row).slice(0, 300)}`, 207, res);
  }
  return row;
}

// Sale format, live-only, and shows. The first call that sets any of these
// publishes the product (it needs price, inventory, description, image and
// required category attributes by then).
export async function merchandise(
  productId: string,
  change: {
    transactionType?: "auction" | "buy_it_now";
    reserveForLive?: boolean;
    shows?: { strategy: "ADD" | "REMOVE" | "REPLACE"; showIds: string[] };
  }
): Promise<void> {
  await call("POST", `/merchandising/products/${id(productId)}`, {
    ...(change.transactionType ? { transaction_type: change.transactionType } : {}),
    ...(change.reserveForLive != null ? { reserve_for_live: change.reserveForLive } : {}),
    ...(change.shows ? { shows: { strategy: change.shows.strategy, show_ids: change.shows.showIds } } : {}),
  });
}

// A product's sale state: transaction_type is null while it's a draft.
// null = no such product.
export type WhatnotMerchandising = { transaction_type?: string | null; reserve_for_live?: boolean | null; active_in_shows?: boolean | null };
export async function getMerchandising(productId: string): Promise<WhatnotMerchandising | null> {
  try {
    return await call<WhatnotMerchandising>("GET", `/merchandising/products/${id(productId)}`);
  } catch (e) {
    if (e instanceof WhatnotError && e.status === 404) return null;
    throw e;
  }
}

export async function listShows(status: "scheduled" | "live"): Promise<WhatnotShow[]> {
  return pageItems(await call<Page<WhatnotShow>>("GET", `/shows?status=${status}&limit=50`)).items;
}

export async function getShow(showId: string): Promise<WhatnotShow> {
  return call("GET", `/shows/${id(showId)}`);
}

export async function getOrder(orderId: string): Promise<WhatnotOrder> {
  return call("GET", `/orders/${id(orderId)}`);
}

export async function listOrders(cursor?: string): Promise<{ items: WhatnotOrder[]; next: string | null }> {
  return pageItems(await call<Page<WhatnotOrder>>("GET", `/orders?limit=50&reverse=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
}

export async function getShipment(shipmentId: string): Promise<WhatnotShipment> {
  return call("GET", `/shipments/${id(shipmentId)}`);
}

// Newest first.
export async function listShipments(cursor?: string): Promise<{ items: WhatnotShipment[]; next: string | null }> {
  return pageItems(await call<Page<WhatnotShipment>>("GET", `/shipments?limit=50&reverse=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
}

// Every item on a shipment (several orders from one buyer share one).
export async function listShipmentItems(shipmentId: string): Promise<WhatnotShipmentItem[]> {
  const out: WhatnotShipmentItem[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: WhatnotShipmentItem[]; next: string | null } = pageItems(
      await call<Page<WhatnotShipmentItem>>("GET", `/shipments/${id(shipmentId)}/items?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    );
    out.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return out;
}

// Asks Whatnot for the shipment's label with its saved settings (weight
// from the items' dimension profiles). 200 = queued, not made yet: it
// arrives as the shipments.label_generated webhook, or on the shipment
// itself (documents.label_url) a little later. 409 = the shipment's state
// or the seller's setup won't allow it.
export async function generateLabel(shipmentId: string): Promise<void> {
  await call("POST", `/shipments/${id(shipmentId)}/generate_label`);
}

export async function listOrderItems(orderId: string): Promise<WhatnotOrderItem[]> {
  const out: WhatnotOrderItem[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: WhatnotOrderItem[]; next: string | null } = pageItems(
      await call<Page<WhatnotOrderItem>>("GET", `/orders/${id(orderId)}/items?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    );
    out.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return out;
}

// Standard Webhooks signature check (Whatnot's webhooks page): HMAC-SHA256
// over "{webhook-id}.{webhook-timestamp}.{raw body}", keyed with the
// base64 secret after its "wn_wh_" prefix, sent base64 in webhook-signature
// as "v1,<sig>" (several, space-separated, during a secret rotation).
// Rejected when the timestamp is more than 5 minutes off.
export function verifyWhatnotWebhook(args: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs?: number;
}): boolean {
  const { id, timestamp, signature } = args;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs((args.nowMs ?? Date.now()) / 1000 - ts) > 5 * 60) return false;
  const key = Buffer.from(args.secret.replace(/^wn_wh_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${args.rawBody}`).digest();
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
