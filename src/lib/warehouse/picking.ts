import { createHash } from "node:crypto";
import type { ItemCondition } from "@/generated/prisma/client";
import { itemDisplayTitle } from "./itemTitle";
import { getOrdersAwaitingShipment } from "../ebay";
import { naturalSort } from "../naturalSort";
import { prisma } from "../prisma";
import { IN_PERSON_TAG } from "../counterSale";
import { getShopifyConfig, shopifyGraphql } from "../shopify";
import { parseBundleComponentUnits } from "../itemUnits";
import { upcMatchKeys } from "../upcMatch";
import { getItemLocations, placeInBin, removeUnits, WarehouseError } from "./bins";
import { classifyScan, normalizeCode } from "./codes";
import { formatLocation } from "./location";
import type { ItemLocation } from "./types";

// Order picking for /ship: which order lines are waiting to be pulled off
// the shelves, and checking each unit by scanning its label so a picker
// can't grab the 3-pack dated 05/2027 when the order is for the one dated
// 09/2026. Nothing here is stored about orders themselves: the open list
// comes live from eBay (and the Shopify store, which also carries Whatnot
// sales) on every load, and the only thing written is one OrderPick row per
// unit picked, plus the bin count coming down.
//
// Nothing in these shapes is money. Employees use this page.

export type PickChannel = "ebay" | "shopify";

// labelled: has an ES label; scanning it is the only check. Usually in a
//   bin, but new stock can still be loose on the binning table (the lister
//   bags and labels it, a separate binning station puts it in bins later).
// in_app_legacy: listed before warehouse mode, no label. Go to its old
//   shelf (or its bin, if it was binned later), check it by its UPC.
// not_in_app: a listing made outside this app (or one it can't match), so
//   there's no record to check against. The picker finds it by title.
// va: the old VA's dropship listings (ended 2026-10-15). Nobody here picks
//   those; the page hides them unless asked.
export type PickStatus = "labelled" | "in_app_legacy" | "not_in_app" | "va";

// What happens to the unit once it's off the shelf. Every kind goes through
// the same scan and removeUnits, so no unit leaves a bin's count without a
// pick behind it:
//   ship    into the shipping pile for that order (the normal case)
//   pickup  the buyer collects it: set it aside to hand over
//   delivery Epic Steals free local delivery (Shopify's Local delivery
//           method): set it aside for the delivery run, no label
//   counter already sold in person at the counter (Shopify POS); the scan
//           just takes it off its bin's count
export type Handoff = "ship" | "pickup" | "delivery" | "counter";

// How a unit is confirmed: its ES label, its product UPC (old items have no
// label), or a tap (an old item with no UPC on record either).
export type VerifyBy = "label" | "upc" | "tap";

export type PickItem = {
  id: string;
  code: string;
  title: string;
  photo: string | null;
  // "MM/YYYY", same as the label prints.
  expiration: string | null;
  condition: string | null;
  packSize: number | null;
  // "3-pack", "Single" or "Bundle: 4 different items". Old-system items
  // have no label to confirm which pack this is, so the page shows it big.
  pack: string;
  // For matching a UPC scan to the right old item on the page without a
  // round trip. Empty for labelled items: those are matched by code only.
  upcKeys: string[];
};

export type PickLine = {
  // channel:lineItemId, unique across both stores.
  key: string;
  channel: PickChannel;
  // Where the buyer bought it: "eBay", "Shopify" or "Whatnot".
  source: string;
  orderId: string;
  // What a person reads: eBay's 12-34567-89012, Shopify's #1001.
  orderNumber: string;
  orderedAt: string;
  // First name or eBay username. Shopify buyers aren't named (that needs
  // protected customer data access the store app doesn't have).
  buyer: string | null;
  lineItemId: string;
  quantity: number;
  picked: number;
  pickedBy: string[];
  status: PickStatus;
  verifyBy: VerifyBy | null;
  // The buyer asked to cancel. Pick it only once that's sorted out.
  cancelRequested: boolean;
  handoff: Handoff;
  item: PickItem | null;
  location: ItemLocation | null;
  // Where to walk to for the next unit: the bin removeUnits will take from
  // first (oldest placement), or the old shelf. binningTable = a labelled
  // item with no bin yet: its units are still on the binning table.
  grabFrom: { shelf: string | null; binCode: string | null; binningTable: boolean };
  // What the store itself says, for lines with no app record.
  listing: { title: string; customLabel: string | null; shelfHint: string | null; image: string | null };
  // The order's page on its own store (eBay Seller Hub or Shopify admin),
  // where the shipping label gets bought once it's packed.
  orderUrl: string | null;
  // Other open eBay orders from the same buyer to the same address
  // (Cristian, 2026-10-21): eBay lets those ship in one box on one label,
  // so they're packed together and get one packing slip. Order numbers,
  // oldest first. Empty for most orders.
  combineWith: string[];
};

export type ShipOrdersResponse = {
  lines: PickLine[];
  fetchedAt: string;
  // off = the Shopify env vars aren't set (always the case locally).
  shopify: "ok" | "off" | "error";
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Reading open orders
// ---------------------------------------------------------------------------

// One normalized line from either store, before it's matched to an Item.
type RawLine = {
  channel: PickChannel;
  source: string;
  orderId: string;
  orderNumber: string;
  orderedAt: string;
  buyer: string | null;
  lineItemId: string;
  quantity: number;
  sku: string | null;
  title: string;
  image: string | null;
  // eBay listing id (legacyItemId), for listings uploaded by CSV whose
  // custom label eBay cut short.
  listingId: string | null;
  shopifyVariantId: string | null;
  cancelRequested: boolean;
  handoff: Handoff;
  // Same value = same buyer, same address (see shipGroupKey). Only for
  // eBay orders that ship. A hash, so no address leaves this module.
  shipGroup: string | null;
};

type EbayRawOrder = {
  orderId: string;
  creationDate: string;
  orderPaymentStatus?: string;
  cancelStatus?: { cancelState?: string };
  buyer?: { username?: string };
  fulfillmentStartInstructions?: {
    fulfillmentInstructionsType?: string;
    shippingStep?: {
      shippingServiceCode?: string;
      shipTo?: {
        fullName?: string;
        contactAddress?: { addressLine1?: string; addressLine2?: string; postalCode?: string; countryCode?: string };
      };
    };
  }[];
  lineItems?: {
    lineItemId: string;
    sku?: string;
    title?: string;
    quantity?: number;
    legacyItemId?: string;
    lineItemFulfillmentStatus?: string;
    image?: { imageUrl?: string };
  }[];
};

// Payment states where nothing should leave the building: a cancelled order
// shows as FULLY_REFUNDED (see isNonSale in ebayOrderSync.ts).
const EBAY_SKIP_PAYMENT = ["FULLY_REFUNDED", "FAILED", "PENDING"];

// Local pickup: the buyer collects it. It still has to come out of its bin
// (and off the bin's count), it just goes to the hand-over spot instead of
// the shipping pile. Confirmed live 2026-10-17: a pickup order reads
// fulfillmentInstructionsType PREPARE_FOR_PICKUP, service code "Pickup".
function isEbayPickup(o: EbayRawOrder): boolean {
  return (o.fulfillmentStartInstructions ?? []).some(
    (f) => f.fulfillmentInstructionsType === "PREPARE_FOR_PICKUP" || /pick\s*up/i.test(f.shippingStep?.shippingServiceCode ?? "")
  );
}

function firstName(full: string | null | undefined): string | null {
  const first = full?.trim().split(/\s+/)[0];
  return first || null;
}

// eBay combines shipping for orders from one buyer to one address, so
// that's the match: the username plus the street, unit, ZIP and country,
// with case, spacing and punctuation ignored. Hashed right away; only the
// hash is kept, in memory.
function shipGroupKey(o: EbayRawOrder): string | null {
  const a = o.fulfillmentStartInstructions?.find((f) => f.shippingStep?.shipTo)?.shippingStep?.shipTo?.contactAddress;
  const who = o.buyer?.username?.trim().toLowerCase();
  if (!who || !a?.addressLine1 || !a.postalCode) return null;
  const norm = (v: string | undefined) => (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const parts = [who, norm(a.addressLine1), norm(a.addressLine2), norm(a.postalCode).slice(0, 5), norm(a.countryCode)];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function ebayLines(orders: EbayRawOrder[]): RawLine[] {
  const out: RawLine[] = [];
  for (const o of orders) {
    const cancelState = o.cancelStatus?.cancelState;
    if (cancelState === "CANCELED") continue;
    if (EBAY_SKIP_PAYMENT.includes(o.orderPaymentStatus ?? "")) continue;
    const handoff: Handoff = isEbayPickup(o) ? "pickup" : "ship";
    const shipTo = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
    const shipGroup = handoff === "ship" ? shipGroupKey(o) : null;
    for (const li of o.lineItems ?? []) {
      // A split shipment can mark one line shipped while the rest wait. A
      // multi-unit line shipped in part reads IN_PROGRESS and stays, with
      // its full quantity: picks are counted against the whole line, so the
      // units already picked for it still count.
      if (li.lineItemFulfillmentStatus === "FULFILLED") continue;
      out.push({
        channel: "ebay",
        source: "eBay",
        orderId: o.orderId,
        orderNumber: o.orderId,
        orderedAt: o.creationDate,
        buyer: firstName(shipTo?.fullName) ?? o.buyer?.username ?? null,
        lineItemId: li.lineItemId,
        quantity: li.quantity ?? 1,
        sku: li.sku?.trim() || null,
        title: li.title ?? li.sku ?? "Untitled listing",
        image: li.image?.imageUrl ?? null,
        listingId: li.legacyItemId ?? null,
        shopifyVariantId: null,
        cancelRequested: cancelState === "CANCEL_REQUESTED",
        handoff,
        shipGroup,
      });
    }
  }
  return out;
}

type ShopifyOpenOrder = {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  sourceName: string | null;
  displayFinancialStatus: string | null;
  tags: string[];
  app: { name: string } | null;
  shippingLines: { nodes: { title: string; deliveryCategory: string | null }[] };
  lineItems: {
    nodes: {
      id: string;
      title: string;
      sku: string | null;
      // After removals and refunds. The line's quantity for picking.
      currentQuantity: number;
      unfulfilledQuantity: number;
      variant: { id: string } | null;
      image: { url: string } | null;
    }[];
  };
};

// Shopify POS sales are fulfilled on the spot, so they never show as
// waiting to ship; they're read separately, by date. Only this recent: a
// counter sale gets scanned off its bin the same day or so, and anything
// older was rung up before warehouse mode (no bins to clear) or has long
// been sorted out by hand. Without a cutoff, every old counter sale would
// sit on the list forever.
const COUNTER_SALE_DAYS = 3;

async function queryShopifyOrders(query: string): Promise<ShopifyOpenOrder[]> {
  const orders: ShopifyOpenOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyOpenOrder[] } } =
      await shopifyGraphql(
        `query($query: String!, $after: String) {
          orders(first: 50, after: $after, query: $query, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id name createdAt cancelledAt sourceName displayFinancialStatus tags
              app { name }
              shippingLines(first: 5) { nodes { title deliveryCategory } }
              lineItems(first: 100) {
                nodes { id title sku currentQuantity unfulfilledQuantity variant { id } image { url } }
              }
            }
          }
        }`,
        { query, after }
      );
    orders.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return orders;
}

// Unfulfilled web orders and Whatnot sales (Whatnot's app writes them into
// this store), plus recent counter (POS) sales. POS orders are closed the
// moment they're rung up, hence no status filter on that one.
async function getShopifyOpenOrders(): Promise<ShopifyOpenOrder[]> {
  const since = new Date(Date.now() - COUNTER_SALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [open, counter] = await Promise.all([
    queryShopifyOrders("status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial)"),
    queryShopifyOrders(`source_name:pos created_at:>='${since}'`),
  ]);
  const seen = new Set(open.map((o) => o.id));
  return [...open, ...counter.filter((o) => !seen.has(o.id))];
}

const SHOPIFY_SKIP_PAYMENT = ["VOIDED", "EXPIRED", "REFUNDED"];

function shopifyLines(orders: ShopifyOpenOrder[]): RawLine[] {
  const out: RawLine[] = [];
  for (const o of orders) {
    if (o.cancelledAt) continue;
    if (SHOPIFY_SKIP_PAYMENT.includes(o.displayFinancialStatus ?? "")) continue;
    // An in-person sale paid by Shopify invoice: the customer already has
    // it, and the app recorded the sale itself (counterSale.ts).
    if (o.tags.includes(IN_PERSON_TAG)) continue;
    const counter = (o.sourceName ?? "").toLowerCase() === "pos";
    // Shopify's deliveryCategory: "local" is Local delivery, "pick-up" is
    // Local pickup. The method name backs it up.
    const delivery = o.shippingLines.nodes.some(
      (s) => /^local$/i.test(s.deliveryCategory ?? "") || /local\s*deliver/i.test(s.title)
    );
    const pickup = o.shippingLines.nodes.some(
      (s) => /pick-?up/i.test(s.deliveryCategory ?? "") || /pick\s*up/i.test(s.title)
    );
    const handoff: Handoff = counter ? "counter" : delivery ? "delivery" : pickup ? "pickup" : "ship";
    const whatnot = /whatnot/i.test(o.app?.name ?? "") || /whatnot/i.test(o.sourceName ?? "");
    for (const li of o.lineItems.nodes) {
      if (li.currentQuantity < 1) continue;
      // A shipping or pickup line is listed while it has units not yet
      // fulfilled. A counter sale is always fulfilled; it's listed until
      // it's scanned off (picked < quantity, on the page).
      if (!counter && li.unfulfilledQuantity < 1) continue;
      out.push({
        channel: "shopify",
        source: whatnot ? "Whatnot" : "Shopify",
        orderId: o.id,
        orderNumber: o.name,
        orderedAt: o.createdAt,
        buyer: null,
        lineItemId: li.id,
        // The whole line, not just what's unfulfilled: picks are counted
        // against the whole line, so after picking 1 of 2 and fulfilling
        // that one in Shopify, the second still reads 1 of 2 picked
        // instead of being refused as already picked.
        quantity: li.currentQuantity,
        sku: li.sku?.trim() || null,
        title: li.title,
        image: li.image?.url ?? null,
        listingId: null,
        shopifyVariantId: li.variant?.id ?? null,
        cancelRequested: false,
        handoff,
        shipGroup: null,
      });
    }
  }
  return out;
}

// One eBay Fulfillment call per load is plenty, but a pick right after the
// list loaded shouldn't make another, and three handhelds refreshing every
// minute shouldn't make three. Per server instance; an order that isn't in
// the cached copy forces a fresh read (see findOpenLine).
const CACHE_MS = 30_000;
let cache: { at: number; promise: Promise<{ lines: RawLine[]; shopify: ShipOrdersResponse["shopify"]; warnings: string[] }> } | null =
  null;

async function fetchOpenLines(): Promise<{ lines: RawLine[]; shopify: ShipOrdersResponse["shopify"]; warnings: string[] }> {
  const warnings: string[] = [];
  const ebayPromise = getOrdersAwaitingShipment().then((o) => ebayLines(o as unknown as EbayRawOrder[]));
  let shopify: ShipOrdersResponse["shopify"] = "off";
  let shopifyPromise: Promise<RawLine[]> = Promise.resolve([]);
  if (getShopifyConfig()) {
    shopifyPromise = getShopifyOpenOrders()
      .then((o) => {
        shopify = "ok";
        return shopifyLines(o);
      })
      .catch((e) => {
        shopify = "error";
        warnings.push(`Couldn't read Shopify orders: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      });
  }
  const [ebay, shop] = await Promise.all([ebayPromise, shopifyPromise]);
  return { lines: [...ebay, ...shop], shopify, warnings };
}

async function getOpenLines(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.promise;
  const promise = fetchOpenLines();
  cache = { at: Date.now(), promise };
  // A failed read shouldn't be served to the next caller.
  promise.catch(() => {
    if (cache?.promise === promise) cache = null;
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Matching order lines to Items
// ---------------------------------------------------------------------------

const ITEM_SELECT = {
  id: true,
  sku: true,
  ebaySku: true,
  ebayListingId: true,
  shopifyVariantId: true,
  finalTitle: true,
  aiTitle: true,
  upcLookupData: true,
  photoUrls: true,
  expirationDate: true,
  condition: true,
  packSize: true,
  isMultipack: true,
  upc: true,
  isBundle: true,
  bundleComponents: true,
  shelfLocation: true,
} as const;

type MatchedItem = {
  id: string;
  sku: string;
  ebaySku: string | null;
  ebayListingId: string | null;
  shopifyVariantId: string | null;
  finalTitle: string | null;
  aiTitle: string | null;
  upcLookupData: unknown;
  photoUrls: string[];
  expirationDate: Date | null;
  condition: ItemCondition | null;
  packSize: number | null;
  isMultipack: boolean;
  upc: string | null;
  isBundle: boolean;
  bundleComponents: unknown;
  shelfLocation: string;
};

// eBay caps a custom label at 50 characters. Listings uploaded by CSV
// carried the full "(Location - A5)-<uuid>" sku (~54 chars), so eBay hands
// back the first 50 (see findListingsBySku in ebay.ts).
const EBAY_SKU_MAX = 50;

async function matchItems(lines: RawLine[]): Promise<Map<string, MatchedItem>> {
  const skus = [...new Set(lines.map((l) => l.sku).filter((s): s is string => Boolean(s)))];
  const listingIds = [...new Set(lines.map((l) => l.listingId).filter((s): s is string => Boolean(s)))];
  const variantIds = [...new Set(lines.map((l) => l.shopifyVariantId).filter((s): s is string => Boolean(s)))];
  const cutShort = skus.filter((s) => s.length === EBAY_SKU_MAX);
  if (skus.length + listingIds.length + variantIds.length === 0) return new Map();

  const items: MatchedItem[] = await prisma.item.findMany({
    where: {
      OR: [
        { ebaySku: { in: skus } },
        { sku: { in: skus } },
        { ebayListingId: { in: listingIds } },
        { shopifyVariantId: { in: variantIds } },
        ...cutShort.map((s) => ({ sku: { startsWith: s } })),
      ],
    },
    select: ITEM_SELECT,
  });

  // Strongest evidence first: the exact id the store gave us, then the sku,
  // then the cut-short sku, then the listing id.
  const result = new Map<string, MatchedItem>();
  for (const line of lines) {
    const key = lineKey(line.channel, line.lineItemId);
    const s = line.sku;
    const found =
      (line.shopifyVariantId && items.find((i) => i.shopifyVariantId === line.shopifyVariantId)) ||
      (s && items.find((i) => i.ebaySku === s)) ||
      (s && items.find((i) => i.sku === s)) ||
      (s && s.length === EBAY_SKU_MAX && line.channel === "ebay" && items.find((i) => i.sku.startsWith(s))) ||
      (line.listingId && items.find((i) => i.ebayListingId === line.listingId)) ||
      null;
    if (found) result.set(key, found);
  }
  return result;
}

// The old VA's dropship listings, by custom label (Cristian's rule,
// 2026-10-15): any s-code (sb2601..., sh..., st...), "am-s...", an ASIN, a
// book ISBN, or "joola wh". The training sandbag ASIN B0CR4HDCJF is his.
// Only checked after the line failed to match an app item.
export function isVaSku(sku: string | null): boolean {
  const s = (sku ?? "").trim();
  if (!s) return false;
  if (/^B0CR4HDCJF$/i.test(s)) return false;
  return (
    /^s/i.test(s) ||
    /^am-s/i.test(s) ||
    /^B0[A-Z0-9]{8}$/i.test(s) ||
    /^(\d{9}[\dX]|\d{13})$/i.test(s) ||
    /^joola wh/i.test(s)
  );
}

// "(Location - A5)-..." or "LocationA12_..." says which shelf an old
// listing went on, even when the app has no record of it.
function shelfFromSku(sku: string | null): string | null {
  if (!sku) return null;
  return sku.match(/^\(Location - ([^)]+)\)/)?.[1] ?? sku.match(/^Location([A-Za-z0-9]+?)_/)?.[1] ?? null;
}

const CONDITION_LABELS: Record<ItemCondition, string> = {
  new: "New",
  new_other: "New (other)",
  used: "Used",
  for_parts: "For parts",
};

export function conditionLabel(c: ItemCondition | null | undefined): string | null {
  return c ? CONDITION_LABELS[c] : null;
}

// "05/2027", what the label prints.
export function monthYear(d: Date | null | undefined): string | null {
  if (!d) return null;
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

function itemTitle(item: MatchedItem): string {
  return itemDisplayTitle(item);
}

// Every UPC that identifies this listing: its own, or for a bundle, its
// parts' (any part in hand means the bundle is in hand).
function itemUpcKeys(item: { upc: string | null; isBundle: boolean; bundleComponents: unknown }): string[] {
  const codes = item.isBundle ? parseBundleComponentUnits(item.bundleComponents).map((c) => c.upc) : [item.upc];
  return [...new Set(codes.flatMap((c) => upcMatchKeys(c)))];
}

function hasLabel(item: { sku: string }): boolean {
  return classifyScan(item.sku) === "item";
}

function verifyFor(item: MatchedItem): VerifyBy {
  if (hasLabel(item)) return "label";
  return itemUpcKeys(item).length > 0 ? "upc" : "tap";
}

export function lineKey(channel: string, lineItemId: string): string {
  return `${channel}:${lineItemId}`;
}

function packText(item: { isBundle: boolean; bundleComponents: unknown; isMultipack: boolean; packSize: number | null }): string {
  if (item.isBundle) {
    const n = Array.isArray(item.bundleComponents) ? item.bundleComponents.length : 0;
    return n > 0 ? `Bundle: ${n} different ${n === 1 ? "item" : "items"}` : "Bundle";
  }
  if (item.isMultipack && item.packSize && item.packSize > 1) return `${item.packSize}-pack`;
  return "Single";
}

function toPickItem(item: MatchedItem, verifyBy: VerifyBy): PickItem {
  return {
    id: item.id,
    code: item.sku,
    title: itemTitle(item),
    photo: item.photoUrls[0] ?? null,
    expiration: monthYear(item.expirationDate),
    condition: conditionLabel(item.condition),
    packSize: item.isMultipack ? item.packSize : null,
    pack: packText(item),
    upcKeys: verifyBy === "label" ? [] : itemUpcKeys(item),
  };
}

// ---------------------------------------------------------------------------
// GET /api/ship/orders
// ---------------------------------------------------------------------------

export async function getPickList(options?: { fresh?: boolean }): Promise<ShipOrdersResponse> {
  const { lines: raw, shopify, warnings } = await getOpenLines(options?.fresh);
  const matched = await matchItems(raw);
  const matchedItems = [...new Map([...matched.values()].map((i) => [i.id, i])).values()];
  const locations = await getItemLocations(matchedItems);
  const picks = raw.length
    ? await prisma.orderPick.findMany({
        where: { lineItemId: { in: raw.map((l) => l.lineItemId) } },
        select: { channel: true, lineItemId: true, pickedBy: true },
      })
    : [];

  const combine = combineGroups(raw.filter((l) => !isVaLine(l, matched)));

  const lines: PickLine[] = raw.map((l) => {
    const key = lineKey(l.channel, l.lineItemId);
    const item = matched.get(key) ?? null;
    const location = item ? (locations.get(item.id) ?? null) : null;
    const linePicks = picks.filter((p) => p.channel === l.channel && p.lineItemId === l.lineItemId);
    const verifyBy = item ? verifyFor(item) : null;
    const status: PickStatus = item
      ? verifyBy === "label"
        ? "labelled"
        : "in_app_legacy"
      : isVaSku(l.sku)
        ? "va"
        : "not_in_app";
    const firstBin = location?.bins[0];
    return {
      key,
      channel: l.channel,
      source: l.source,
      orderId: l.orderId,
      orderNumber: l.orderNumber,
      orderedAt: l.orderedAt,
      buyer: l.buyer,
      lineItemId: l.lineItemId,
      quantity: l.quantity,
      picked: linePicks.length,
      pickedBy: [...new Set(linePicks.map((p) => p.pickedBy).filter((b): b is string => Boolean(b)))],
      status,
      verifyBy,
      cancelRequested: l.cancelRequested,
      handoff: l.handoff,
      item: item && verifyBy ? toPickItem(item, verifyBy) : null,
      location,
      grabFrom: firstBin
        ? { shelf: firstBin.shelfLabel, binCode: firstBin.binCode, binningTable: false }
        : {
            shelf: location?.legacyShelf ?? (item ? null : shelfFromSku(l.sku)),
            binCode: null,
            binningTable: verifyBy === "label",
          },
      listing: { title: l.title, customLabel: l.sku, shelfHint: shelfFromSku(l.sku), image: l.image },
      orderUrl: orderUrl(l),
      combineWith: (combine.get(l.orderId) ?? []).filter((o) => o.orderId !== l.orderId).map((o) => o.orderNumber),
    };
  });

  return { lines: sortWalkingPath(lines), fetchedAt: new Date().toISOString(), shopify, warnings };
}

// The old VA's lines: nobody here picks or packs those, so they never make
// an order part of a ship-together group.
function isVaLine(l: RawLine, matched: Map<string, MatchedItem>): boolean {
  return !matched.has(lineKey(l.channel, l.lineItemId)) && isVaSku(l.sku);
}

// orderId -> every open order in its ship-together group (itself included),
// oldest first. Only groups of two or more orders.
type GroupOrder = { orderId: string; orderNumber: string; orderedAt: string };
function combineGroups(lines: RawLine[]): Map<string, GroupOrder[]> {
  const byGroup = new Map<string, Map<string, GroupOrder>>();
  for (const l of lines) {
    if (!l.shipGroup) continue;
    const orders = byGroup.get(l.shipGroup) ?? new Map<string, GroupOrder>();
    orders.set(l.orderId, { orderId: l.orderId, orderNumber: l.orderNumber, orderedAt: l.orderedAt });
    byGroup.set(l.shipGroup, orders);
  }
  const out = new Map<string, GroupOrder[]>();
  for (const orders of byGroup.values()) {
    if (orders.size < 2) continue;
    const list = [...orders.values()].sort((a, b) => a.orderedAt.localeCompare(b.orderedAt));
    for (const o of list) out.set(o.orderId, list);
  }
  return out;
}

// Walking order: the binning table first, then shelves (A2 before A10),
// then bin, oldest order first among equals. Lines with nowhere to walk to
// (an unshelved bin, a listing with no location) come after, and the VA's
// last.
//
// The binning table goes first because it's one stop by the stations,
// where a pick round starts anyway: grab everything still loose there,
// then walk the shelves once, instead of finishing the aisles and having
// to come back for it.
// Shipping labels are bought on the order's own store (Cristian,
// 2026-10-17), so Ready to pack links straight to it. eBay: the Seller Hub
// order page (has Print shipping label). Shopify and Whatnot: the order in
// Shopify admin ({shop}/admin/orders/{id} goes to admin.shopify.com).
function orderUrl(l: Pick<RawLine, "channel" | "orderId">): string | null {
  if (l.channel === "ebay") return `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(l.orderId)}`;
  const shop = getShopifyConfig()?.shop;
  const id = l.orderId.split("/").pop();
  return shop && id ? `https://${shop}/admin/orders/${id}` : null;
}

export function sortWalkingPath(lines: PickLine[]): PickLine[] {
  const byAge = [...lines].sort((a, b) => a.orderedAt.localeCompare(b.orderedAt));
  const group = (l: PickLine) =>
    l.status === "va" ? 4 : l.grabFrom.binningTable ? 0 : l.grabFrom.shelf ? 1 : l.grabFrom.binCode ? 2 : 3;
  const sorted = naturalSort(naturalSort(byAge, (l) => l.grabFrom.binCode ?? ""), (l) => l.grabFrom.shelf ?? "");
  return [0, 1, 2, 3, 4].flatMap((g) => sorted.filter((l) => group(l) === g));
}

// ---------------------------------------------------------------------------
// Scanned-item details (wrong item, or nothing needs it)
// ---------------------------------------------------------------------------

export type ScannedItem = {
  code: string;
  title: string;
  expiration: string | null;
  condition: string | null;
  location: string;
};

// What a scanned label or UPC is, for "That's ES000456 (...)". null when
// the app has no such item. A UPC can match several listings; the newest
// one still for sale is the best guess.
export async function describeScan(rawCode: string): Promise<ScannedItem | null> {
  const code = normalizeCode(rawCode);
  const kind = classifyScan(code);
  let item: MatchedItem | null = null;
  if (kind === "upc") {
    const keys = new Set(upcMatchKeys(code));
    // The six digits before the check digit are in every stored form of
    // this UPC (with or without its check digit or leading zeros), so they
    // narrow the search before the loose match below.
    const candidates: MatchedItem[] = await prisma.item.findMany({
      where: { upc: { contains: code.slice(-7, -1) } },
      select: ITEM_SELECT,
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    item = candidates.find((c) => upcMatchKeys(c.upc).some((k) => keys.has(k))) ?? null;
  } else {
    item = await prisma.item.findFirst({ where: { sku: { equals: code, mode: "insensitive" } }, select: ITEM_SELECT });
  }
  if (!item) return null;
  const loc = (await getItemLocations([item])).get(item.id);
  return {
    code: item.sku,
    title: itemTitle(item),
    expiration: monthYear(item.expirationDate),
    condition: conditionLabel(item.condition),
    location: formatLocation(loc),
  };
}

// ---------------------------------------------------------------------------
// POST /api/ship/pick
// ---------------------------------------------------------------------------

export type PickRequest = {
  orderId: string;
  channel: PickChannel;
  lineItemId: string;
  scannedCode: string;
  binCode?: string | null;
  // "Can't scan it? Found it" for an old-system item (no label): the UPC is
  // missing, worn or won't read. Never accepted for an ES-labelled item.
  manual?: boolean;
};

export type ExpectedItem = { code: string; title: string; expiration: string | null; condition: string | null };

export type PickResponse =
  | {
      ok: true;
      picked: number;
      quantity: number;
      takenFromBin: string | null;
      // Set when the count didn't come out of the bin you'd expect (an
      // item with bins elsewhere, or none left on record). The pick still
      // counts; the bin count is just off.
      binNote: string | null;
      // Confirmed by a "Found it" tap instead of a scan. OrderPick has no
      // column for it, so it's only reported back here.
      manual: boolean;
      orderNumber: string;
    }
  | {
      ok: false;
      reason: string;
      // wrong_item | already_picked | not_open | not_in_app | scan_label | not_an_item
      code: string;
      scannedItem?: ScannedItem | null;
      expected?: ExpectedItem;
      picked?: number;
      quantity?: number;
    };

// Finds the line in the open orders, re-reading the stores once if the
// cached copy doesn't have it (an order that came in seconds ago).
async function findOpenLine(req: { channel: PickChannel; orderId: string; lineItemId: string }) {
  const match = (lines: RawLine[]) =>
    lines.find((l) => l.channel === req.channel && l.orderId === req.orderId && l.lineItemId === req.lineItemId) ?? null;
  const cached = await getOpenLines();
  return match(cached.lines) ?? match((await getOpenLines(true)).lines);
}

// Two pickers scanning the same line at the same moment queue up here, so
// the second one sees the first one's pick and can't take one too many.
function lockKey(channel: string, lineItemId: string) {
  return `orderpick:${channel}:${lineItemId}`;
}

export async function pickUnit(req: PickRequest, by: string | null): Promise<PickResponse> {
  const line = await findOpenLine(req);
  if (!line) {
    return { ok: false, code: "not_open", reason: "That order isn't waiting to ship any more. It may have shipped or been cancelled." };
  }
  const item = (await matchItems([line])).get(lineKey(line.channel, line.lineItemId));
  if (!item) {
    return { ok: false, code: "not_in_app", reason: "This one isn't in the app, so it can't be checked. Find it by its title." };
  }
  const expected: ExpectedItem = {
    code: item.sku,
    title: itemTitle(item),
    expiration: monthYear(item.expirationDate),
    condition: conditionLabel(item.condition),
  };

  const before = await prisma.orderPick.count({ where: { channel: line.channel, lineItemId: line.lineItemId } });
  if (before >= line.quantity) {
    return { ok: false, code: "already_picked", reason: "already picked", picked: before, quantity: line.quantity, expected };
  }

  // Is this the right thing?
  const scanned = normalizeCode(req.scannedCode ?? "");
  const verifyBy = verifyFor(item);
  const kind = classifyScan(scanned);
  let scanMatched = false;
  if (scanned && scanned === normalizeCode(item.sku)) scanMatched = true;
  else if (verifyBy === "upc" && kind === "upc") {
    const keys = new Set(itemUpcKeys(item));
    scanMatched = upcMatchKeys(scanned).some((k) => keys.has(k));
  }
  // The tap fallback is for old-system items only (no label to scan).
  const manual = !scanMatched && verifyBy !== "label" && req.manual === true;
  const correct = scanMatched || manual;

  if (!correct && req.manual === true && verifyBy === "label") {
    return {
      ok: false,
      code: "scan_label",
      reason: `New items have to be scanned. Find the ES label on the bag: you need ${item.sku}.`,
      expected,
    };
  }

  if (!correct) {
    if (verifyBy === "label" && kind === "upc") {
      return {
        ok: false,
        code: "scan_label",
        reason: `Scan the ES label on the bag, not the product barcode. You need ${item.sku}.`,
        expected,
      };
    }
    if (kind !== "item" && kind !== "upc") {
      // Old items' skus are long "(Location - A5)-<uuid>" strings nobody
      // can read off anything, so point at the UPC instead.
      const need = verifyBy === "label" ? `You need ${item.sku}.` : "Scan the product's UPC barcode.";
      return { ok: false, code: "not_an_item", reason: `That's not an item label. ${need}`, expected };
    }
    const scannedItem = await describeScan(scanned);
    return {
      ok: false,
      code: "wrong_item",
      reason: scannedItem ? "Wrong item" : `Nothing in the app has the code ${scanned}`,
      scannedItem,
      expected,
    };
  }

  const preferBinCode = req.binCode ? normalizeCode(req.binCode) : null;
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(line.channel, line.lineItemId)}::text))`;
      const picked = await tx.orderPick.count({ where: { channel: line.channel, lineItemId: line.lineItemId } });
      if (picked >= line.quantity) return { already: true as const, picked };
      const binsBefore = await tx.binContent.count({ where: { itemId: item.id } });
      const taken = await removeUnits(tx, {
        itemId: item.id,
        units: 1,
        kind: "pick",
        by,
        preferBinCode,
        note: `Order ${line.orderNumber}`,
      });
      const takenFromBin = taken[0]?.binCode ?? null;
      await tx.orderPick.create({
        data: {
          channel: line.channel,
          orderId: line.orderId,
          lineItemId: line.lineItemId,
          itemId: item.id,
          binCode: takenFromBin,
          pickedBy: by,
        },
      });
      let binNote: string | null = null;
      if (!takenFromBin && binsBefore > 0) {
        binNote = "No units of this item were left in any bin on record, so no bin count changed. Tell Cristian.";
      } else if (!takenFromBin && verifyBy === "label") {
        // Normal for new stock: still on the binning table, so there's no
        // bin count to take it off.
        binNote = "It wasn't in a bin yet, so no bin count changed. That's fine.";
      } else if (takenFromBin && preferBinCode && takenFromBin !== preferBinCode) {
        binNote = `The records didn't have it in ${preferBinCode}, so it came off ${takenFromBin}'s count.`;
      }
      return { already: false as const, picked: picked + 1, takenFromBin, binNote };
    },
    { timeout: 35_000, maxWait: 10_000 }
  );

  if (result.already) {
    return { ok: false, code: "already_picked", reason: "already picked", picked: result.picked, quantity: line.quantity, expected };
  }
  return {
    ok: true,
    picked: result.picked,
    quantity: line.quantity,
    takenFromBin: result.takenFromBin,
    binNote: result.binNote,
    manual,
    orderNumber: line.orderNumber,
  };
}

// ---------------------------------------------------------------------------
// One order, for its packing slip (warehouse/packingSlip.ts)
// ---------------------------------------------------------------------------

export type OrderForSlip = {
  channel: PickChannel;
  orderId: string;
  orderNumber: string;
  source: string;
  buyer: string | null;
  orderedAt: string;
  handoff: Handoff;
  lines: { title: string; quantity: number; picked: number; code: string | null }[];
  // Same rule as "Ready to pack" on /ship: every line the app can check is
  // picked (and there's at least one).
  fullyPicked: boolean;
  // Has a line the app can check. An order that's all "find it yourself"
  // can't be scanned complete, so it never holds up the orders it ships with.
  checkable: boolean;
};

// The order plus any open orders it ships with (same buyer, same address),
// oldest first. Just [order] when it ships alone; [] when it isn't open.
export async function ordersShippingTogether(channel: PickChannel, orderId: string): Promise<OrderForSlip[]> {
  const read = async (fresh: boolean) => {
    const all = (await getOpenLines(fresh)).lines;
    return { all, mine: all.filter((l) => l.channel === channel && l.orderId === orderId) };
  };
  let { all, mine } = await read(false);
  if (mine.length === 0) ({ all, mine } = await read(true));
  if (mine.length === 0) return [];
  const group = mine[0].shipGroup;
  if (!group) return [await buildOrderForSlip(mine)];
  const inGroup = all.filter((l) => l.shipGroup === group);
  const matched = await matchItems(inGroup);
  const ids = (combineGroups(inGroup.filter((l) => !isVaLine(l, matched))).get(orderId) ?? []).map((o) => o.orderId);
  if (ids.length < 2) return [await buildOrderForSlip(mine)];
  return Promise.all(ids.map((id) => buildOrderForSlip(inGroup.filter((l) => l.orderId === id))));
}

async function buildOrderForSlip(lines: RawLine[]): Promise<OrderForSlip> {
  const first = lines[0];
  const [items, picks] = await Promise.all([
    matchItems(lines),
    prisma.orderPick.groupBy({ by: ["lineItemId"], where: { channel: first.channel, orderId: first.orderId }, _count: { _all: true } }),
  ]);
  const checkable: { picked: number; quantity: number }[] = [];
  const out = lines.map((l) => {
    const item = items.get(lineKey(l.channel, l.lineItemId)) ?? null;
    const picked = picks.find((p) => p.lineItemId === l.lineItemId)?._count._all ?? 0;
    if (item) checkable.push({ picked, quantity: l.quantity });
    return { title: item ? itemTitle(item) : l.title, quantity: l.quantity, picked, code: item?.sku ?? l.sku };
  });
  return {
    channel: first.channel,
    orderId: first.orderId,
    orderNumber: first.orderNumber,
    source: first.source,
    buyer: first.buyer,
    orderedAt: first.orderedAt,
    handoff: first.handoff,
    lines: out,
    fullyPicked: checkable.length > 0 && checkable.every((l) => l.picked >= l.quantity),
    checkable: checkable.length > 0,
  };
}

// ---------------------------------------------------------------------------
// POST /api/ship/unpick
// ---------------------------------------------------------------------------

export type UnpickResponse = { ok: true; picked: number; returnedToBin: string | null } | { ok: false; reason: string };

// Takes back the latest pick on a line (scanned the wrong order's pile, put
// it back on the shelf) and puts the unit back in the bin it came out of.
// The owner can undo anyone's pick; others only their own.
export async function unpickUnit(
  req: { channel: PickChannel; orderId: string; lineItemId: string },
  user: { username: string; role: string }
): Promise<UnpickResponse> {
  const last = await prisma.orderPick.findFirst({
    where: { channel: req.channel, orderId: req.orderId, lineItemId: req.lineItemId },
    orderBy: { createdAt: "desc" },
  });
  if (!last) return { ok: false, reason: "Nothing picked on that line yet." };
  if (user.role !== "owner" && last.pickedBy !== user.username) {
    return { ok: false, reason: `${last.pickedBy ?? "Someone else"} picked that one. Ask them or Cristian to undo it.` };
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(req.channel, req.lineItemId)}::text))`;
        // Re-read under the lock: someone may have undone it a moment ago.
        const pick = await tx.orderPick.findUnique({ where: { id: last.id } });
        if (!pick) {
          const picked = await tx.orderPick.count({ where: { channel: req.channel, lineItemId: req.lineItemId } });
          return { ok: true as const, picked, returnedToBin: null };
        }
        await tx.orderPick.delete({ where: { id: pick.id } });
        if (pick.binCode) {
          // placeInBin treats "empty bin that's still on a shelf" as a bin
          // brought back to a station and takes it off its shelf. Here the
          // bin never left: the last unit just came out of it a moment ago.
          // So put its shelf back the way it was.
          const bin = await tx.bin.findUnique({ where: { code: pick.binCode } });
          const wasEmpty = bin ? (await tx.binContent.count({ where: { binId: bin.id } })) === 0 : false;
          await placeInBin(tx, { itemId: pick.itemId, binCode: pick.binCode, units: 1, by: user.username, note: "Pick undone" });
          if (bin?.shelfLabel && wasEmpty) {
            await tx.bin.update({
              where: { id: bin.id },
              data: { shelfLabel: bin.shelfLabel, shelvedAt: bin.shelvedAt, shelvedBy: bin.shelvedBy },
            });
            await tx.binMove.create({
              data: {
                kind: "shelve",
                fromBinCode: bin.code,
                shelfLabel: bin.shelfLabel,
                note: "Pick undone, bin stayed on its shelf",
                by: user.username,
              },
            });
          }
        }
        const picked = await tx.orderPick.count({ where: { channel: req.channel, lineItemId: req.lineItemId } });
        return { ok: true as const, picked, returnedToBin: pick.binCode };
      },
      { timeout: 35_000, maxWait: 10_000 }
    );
  } catch (e) {
    if (e instanceof WarehouseError) return { ok: false, reason: e.message };
    throw e;
  }
}
