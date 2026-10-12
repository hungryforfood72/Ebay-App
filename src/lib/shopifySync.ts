import { after } from "next/server";
import {
  getEbayEnvironment,
  getLiveAvailableQuantity,
  reviseFixedPriceItemQuantity,
  updateOfferQuantity,
} from "./ebay";
import { formatExpiration } from "./formatExpiration";
import { prisma } from "./prisma";
import {
  addTags,
  archiveProduct,
  removeTags,
  createProduct,
  ensureTagCollection,
  findProductByHandle,
  getLocation,
  getOrdersUpdatedSince,
  getPublications,
  getShopifyConfig,
  publishToChannels,
  readStock,
  setAvailable,
  unpublishFromChannels,
  updateDescription,
  updateVariantPrice,
  type ShopifyOrder,
  type ShopifyStockState,
} from "./shopify";
import { withSyncLock } from "./syncLock";
import type { Item, Prisma } from "@/generated/prisma/client";

// Keeps the Shopify store (and Whatnot, which sells from it) in step with
// eBay. The app's own Item.quantity/soldQuantity is the one stock count
// for every channel:
// - A Shopify or Whatnot sale is recorded as a ShopifySale and comes off
//   the eBay listing right away (from eBay's live count, the same way a
//   walk-up sale does, so an eBay sale the app hasn't synced yet is never
//   overwritten).
// - An eBay sale is recorded by the eBay order sync as always; this then
//   sets Shopify to what's left.
// - Every 10 minutes the cron checks every Shopify product's count and
//   price against the app's numbers and fixes any that drifted.
// Shopify writes use Shopify's compare-and-swap, so a Shopify sale landing
// mid-update is never written over: the update just waits for next run.

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

// Cristian: Shopify buyers pay their own shipping, so the price is this
// much under the eBay price (which includes free shipping).
const DISCOUNT_PCT_KEY = "shopify_price_discount_pct";
const DEFAULT_DISCOUNT_PCT = 10;

export async function getShopifyDiscountPct(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: DISCOUNT_PCT_KEY } });
  const value = row ? Number(row.value) : NaN;
  return Number.isFinite(value) && value >= 0 && value < 100 ? value : DEFAULT_DISCOUNT_PCT;
}

export async function setShopifyDiscountPct(pct: number): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: DISCOUNT_PCT_KEY },
    create: { key: DISCOUNT_PCT_KEY, value: String(pct) },
    update: { value: String(pct) },
  });
}

export function shopifyPriceFor(ebayPrice: number, discountPct: number): number {
  return Math.round(ebayPrice * (1 - discountPct / 100) * 100) / 100;
}

// Cristian: short-dated and past-date items go 65% off the regular store
// price (the original eBay price, from before any eBay discount, less the
// store discount).
const PAST_DATE_OFF_PCT = 65;

// The crossed-out price is the item's retail price when there's a
// believable one (see believableRetail), labeled "Retail" by the theme
// through RETAIL_TAG. Without one: past-date items show the regular store
// price crossed out, regular items show none.
export const RETAIL_TAG = "retail-compare";
// Supplier manifests sometimes carry inflated "retail" values (a box of
// Nexcare DUO bandages at $21, really ~$6). Showing one of those as the
// struck-through price would be a fake discount, so retail only counts
// when it's at most this many times the original eBay price, which is
// what the item actually goes for.
const MAX_RETAIL_TO_EBAY = 3;

type ExpectedPrices = { price: number; compareAt: number | null; retailCompare: boolean };

function expectedPrices(
  item: Pick<Item, "price" | "originalPrice" | "pastDateAt">,
  discountPct: number,
  retail: number | null
): ExpectedPrices {
  const original = Number(item.originalPrice ?? item.price ?? 0);
  const regular = shopifyPriceFor(original, discountPct);
  const price = item.pastDateAt
    ? Math.max(0.5, Math.round(regular * (1 - PAST_DATE_OFF_PCT / 100) * 100) / 100)
    : shopifyPriceFor(Number(item.price ?? 0), discountPct);
  const goodRetail = believableRetail(retail, price, original);
  if (goodRetail != null) return { price, compareAt: goodRetail, retailCompare: true };
  return { price, compareAt: item.pastDateAt ? regular : null, retailCompare: false };
}

// Retail worth showing: on record, at least 5% above what it sells for
// here (several items sell above manifest retail, since the eBay price
// includes shipping), and not wildly above the original eBay price.
function believableRetail(retail: number | null, price: number, ebayOriginal: number): number | null {
  if (retail == null || retail <= 0) return null;
  if (retail < price * 1.05) return null;
  if (ebayOriginal > 0 && retail > ebayOriginal * MAX_RETAIL_TO_EBAY) return null;
  return Math.round(retail * 100) / 100;
}

// Retail for each item's whole listing (a 3-pack is 3x the unit retail),
// from its manifest line. Bundles and items scanned outside a manifest
// have none.
async function retailPrices(
  items: Pick<Item, "id" | "manifestId" | "upc" | "isMultipack" | "packSize" | "isBundle">[]
): Promise<Map<string, number>> {
  const wanted = items.filter((i) => i.manifestId && i.upc && !i.isBundle);
  const result = new Map<string, number>();
  if (wanted.length === 0) return result;
  const lines = await prisma.manifestLine.findMany({
    where: { OR: wanted.map((i) => ({ manifestId: i.manifestId!, upc: i.upc! })) },
    select: { manifestId: true, upc: true, retailPrice: true },
  });
  for (const i of wanted) {
    const line = lines.find((l) => l.manifestId === i.manifestId && l.upc === i.upc && Number(l.retailPrice) > 0);
    if (!line) continue;
    const pack = i.isMultipack && i.packSize ? i.packSize : 1;
    result.set(i.id, Number(line.retailPrice) * pack);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Which items belong on Shopify
// ---------------------------------------------------------------------------

type LiveFields = Pick<
  Item,
  "status" | "listingEndedAt" | "expiredAt" | "ebayOfferId" | "ebayListingId" | "shopifyOnly" | "pastDateAt"
>;

// Still for sale: live on eBay, or a Shopify & Whatnot only item that's
// been published (or is mid-publish from review, "ready"). Once that's
// over (sold out, expired, ended), the Shopify product is archived too:
// Cristian never restocks a listing.
function isLive(item: LiveFields): boolean {
  if (item.expiredAt) return false;
  // Off eBay already (listingEndedAt is set), still for sale on the store
  // until expireListings pulls it 6 months past its date.
  if (item.pastDateAt) return item.status === "listed" || item.status === "exported";
  if (item.listingEndedAt) return false;
  if (item.shopifyOnly) return item.status === "listed" || item.status === "ready";
  return (item.status === "listed" || item.status === "exported") && Boolean(item.ebayOfferId || item.ebayListingId);
}

function shopifyTarget(item: LiveFields & Pick<Item, "quantity" | "soldQuantity">): number {
  return isLive(item) ? Math.max(0, item.quantity - item.soldQuantity) : 0;
}

// Everything live on eBay and not on Shopify yet, plus Shopify-only items
// whose publish from review didn't finish (retried; a "ready" one is only
// ever published by its own Publish button), plus past-date items that
// were never on Shopify (brought back after being pulled; they go up
// straight onto the past-date page). Local-pickup-only items stay off: a
// Shopify buyer would be charged shipping on something that can't ship.
function waitingForShopifyWhere(): Prisma.ItemWhereInput {
  return {
    status: { in: ["listed", "exported"] },
    OR: [
      {
        ebayEnvironment: getEbayEnvironment(),
        listingEndedAt: null,
        OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }],
      },
      { shopifyOnly: true, listingEndedAt: null },
      { pastDateAt: { not: null } },
    ],
    expiredAt: null,
    shopifyPublishedAt: null,
    shopifyArchivedAt: null,
    localPickupOnly: false,
    finalTitle: { not: null },
    price: { not: null },
    NOT: { photoUrls: { isEmpty: true } },
  };
}

export async function shopifyCounts(): Promise<{ onShopify: number; waiting: number; failed: number }> {
  const [onShopify, waiting, failed] = await Promise.all([
    prisma.item.count({ where: { shopifyPublishedAt: { not: null }, shopifyArchivedAt: null } }),
    prisma.item.count({ where: { ...waitingForShopifyWhere(), shopifyError: null } }),
    prisma.item.count({ where: { ...waitingForShopifyWhere(), shopifyError: { not: null } } }),
  ]);
  return { onShopify, waiting, failed };
}

// ---------------------------------------------------------------------------
// Channel rules
// ---------------------------------------------------------------------------

// eBay categories Whatnot doesn't allow: its supplements policy bars
// over-the-counter medications (Tylenol, NyQuil, Mucinex...). Those stay
// on the Shopify store and every other channel, just never on Whatnot.
// Matched against the item's eBay category path. Vitamins and dietary
// supplements are allowed there and aren't matched.
const WHATNOT_BLOCKED_CATEGORY = /Over-the-Counter Medications/i;

function isWhatnotChannel(name: string): boolean {
  return /whatnot/i.test(name);
}

async function categoryPaths(categoryIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(categoryIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.ebayCategory.findMany({ where: { id: { in: ids } }, select: { id: true, path: true } });
  return new Map(rows.map((r) => [r.id, r.path]));
}

// ---------------------------------------------------------------------------
// Past-date lane
// ---------------------------------------------------------------------------

const PAST_DATE_TAG = "past-date";
// The theme's templates/collection.past-date.json shows this one.
const PAST_DATE_COLLECTION = {
  handle: "past-date-deals",
  title: "Past-Date & Short-Dated Deals",
  templateSuffix: "past-date",
  descriptionHtml:
    "<p>Close to or past the date printed on the package, so they're an extra 65% off our regular prices. Every item shows its date. Check it before you buy.</p>",
};

function pastDateDisclosure(item: Item): string {
  const date = item.expirationDate ? formatExpiration(item.expirationDate) : null;
  return (
    `<p><strong>Short-dated or past its date${date ? `: ${date}` : ""}.</strong> ` +
    `It's marked down an extra 65% from our regular price because it's close to or past the date printed on the package. ` +
    `Please check the date before you buy.</p>`
  );
}

// Switches a product over once its item enters the lane (see
// expireListings.ts): disclosure first in the description, tagged into the
// Past-Date Deals collection, and on the Online Store only (off Whatnot,
// which bars expired items, and every other channel). The price follows in
// the sync's regular price check.
async function applyPastDate(item: Item, publications: { id: string; name: string }[]): Promise<void> {
  const onlineStore = publications.find((p) => /^online store$/i.test(p.name));
  if (!onlineStore) throw new Error("No Online Store channel found to keep the past-date item on.");
  await ensureTagCollection({ ...PAST_DATE_COLLECTION, tag: PAST_DATE_TAG, publicationIds: [onlineStore.id] });
  const tags = [PAST_DATE_TAG];
  if (item.expirationDate) tags.push(`Best by: ${formatExpiration(item.expirationDate)}`);
  await addTags(item.shopifyProductId!, tags);
  await updateDescription(item.shopifyProductId!, pastDateDisclosure(item) + shopifyDescription(item));
  await unpublishFromChannels(
    item.shopifyProductId!,
    publications.filter((p) => p.id !== onlineStore.id).map((p) => p.id)
  );
  await prisma.item.update({ where: { id: item.id }, data: { shopifyPastDateAppliedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

const CONDITION_LABEL: Record<string, string> = {
  new: "New",
  new_other: "New (other)",
  used: "Used",
  for_parts: "For parts or not working",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The eBay description is usually HTML already; plain text gets
// paragraphs so its line breaks survive. Condition and expiration are
// eBay fields with no Shopify equivalent, so they're spelled out here.
function shopifyDescription(item: Item): string {
  const base = item.finalDescription ?? "";
  const body = /<[a-z][^>]*>/i.test(base)
    ? base
    : base
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
  const facts: string[] = [];
  if (item.condition) facts.push(`<li><strong>Condition:</strong> ${CONDITION_LABEL[item.condition] ?? item.condition}</li>`);
  if (item.expirationDate) facts.push(`<li><strong>Expiration date:</strong> ${formatExpiration(item.expirationDate)}</li>`);
  return facts.length ? `${body}<ul>${facts.join("")}</ul>` : body;
}

// Fixed per item, so a retry after a half-finished publish finds the
// product it already made instead of making a second one.
function shopifyHandle(item: Item): string {
  const slug = (item.finalTitle ?? "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return `${slug || "item"}-${item.id.slice(0, 8)}`;
}

export type PublishOutcome = "published" | "nothing_left" | "not_eligible";

// Puts one item on Shopify: finds or creates the product, then publishes
// it to every sales channel the store has. Saves the error on the item and
// rethrows when it fails, so Settings can show it and a retry can pick it
// up.
// fromReview: the Publish button on a Shopify & Whatnot only item, which
// is still "ready" until this succeeds and flips it to "listed".
export async function publishItemToShopify(itemId: string, options?: { fromReview?: boolean }): Promise<PublishOutcome> {
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item) throw new Error("Item not found.");
  const where = waitingForShopifyWhere();
  const eligible = await prisma.item.count({
    where: options?.fromReview
      ? { ...where, id: itemId, shopifyOnly: true, status: "ready", OR: undefined }
      : { ...where, id: itemId },
  });
  if (!eligible) return "not_eligible";

  try {
    let available = Math.max(0, item.quantity - item.soldQuantity);
    // The older CSV listings' eBay counts were set by hand and are the
    // right ones (see getLiveAvailableQuantity). Once Shopify sells from
    // the same stock, this app's count has to agree with eBay's, so line it
    // up here, on the record.
    if (!item.ebayOfferId && item.ebayListingId && !item.listingEndedAt) {
      const live = await getLiveAvailableQuantity(item);
      if (live != null && live !== available) {
        await prisma.$transaction([
          prisma.item.update({ where: { id: item.id }, data: { quantity: live + item.soldQuantity } }),
          prisma.stockAdjustment.create({
            data: {
              itemId: item.id,
              delta: live - available,
              previousAvailable: available,
              newAvailable: live,
              note: "Matched to eBay's live count before listing on Shopify",
              recordedBy: "system",
            },
          }),
        ]);
        available = live;
      }
    }
    if (available <= 0) return "nothing_left";

    const [location, discountPct, category] = await Promise.all([
      getLocation(),
      getShopifyDiscountPct(),
      item.categoryId ? prisma.ebayCategory.findUnique({ where: { id: item.categoryId } }) : null,
    ]);
    const specifics = (item.itemSpecifics ?? {}) as Record<string, string>;
    const handle = shopifyHandle(item);
    const weightLbs = (item.weightLbs ?? 0) + (item.weightOz ?? 0) / 16;
    // A past-date item goes up already in its past-date state: price,
    // disclosure, tags and Online Store only, never a moment at full price
    // or on Whatnot.
    const pastDate = Boolean(item.pastDateAt);
    const prices = expectedPrices(item, discountPct, (await retailPrices([item])).get(item.id) ?? null);
    const tags = item.condition ? [`Condition: ${CONDITION_LABEL[item.condition] ?? item.condition}`] : [];
    if (prices.retailCompare) tags.push(RETAIL_TAG);
    if (pastDate) {
      tags.push(PAST_DATE_TAG);
      if (item.expirationDate) tags.push(`Best by: ${formatExpiration(item.expirationDate)}`);
    }

    // Already made on an earlier try that failed before publishing: reuse
    // it, even if the title (and so the handle) changed since.
    const saved =
      item.shopifyProductId && item.shopifyVariantId && item.shopifyInventoryItemId
        ? { productId: item.shopifyProductId, variantId: item.shopifyVariantId, inventoryItemId: item.shopifyInventoryItemId }
        : null;
    const refs =
      saved ??
      (await findProductByHandle(handle)) ??
      (await createProduct({
        handle,
        title: item.finalTitle!,
        descriptionHtml: pastDate ? pastDateDisclosure(item) + shopifyDescription(item) : shopifyDescription(item),
        vendor: specifics.brand?.trim() || null,
        productType: category?.name ?? null,
        tags,
        photoUrls: item.photoUrls,
        price: prices.price,
        compareAtPrice: prices.compareAt,
        sku: item.sku,
        barcode: item.upc,
        weightLbs: weightLbs > 0 ? weightLbs : null,
        quantity: available,
        locationId: location.id,
      }));
    await prisma.item.update({
      where: { id: item.id },
      data: {
        shopifyProductId: refs.productId,
        shopifyVariantId: refs.variantId,
        shopifyInventoryItemId: refs.inventoryItemId,
      },
    });

    const publications = await getPublications();
    let channels: { id: string; name: string }[];
    if (pastDate) {
      const onlineStore = publications.find((p) => /^online store$/i.test(p.name));
      if (!onlineStore) throw new Error("No Online Store channel found to put the past-date item on.");
      await ensureTagCollection({ ...PAST_DATE_COLLECTION, tag: PAST_DATE_TAG, publicationIds: [onlineStore.id] });
      channels = [onlineStore];
    } else {
      const blockedOnWhatnot = WHATNOT_BLOCKED_CATEGORY.test(category?.path ?? "");
      channels = publications.filter((p) => !(blockedOnWhatnot && isWhatnotChannel(p.name)));
    }
    await publishToChannels(refs.productId, channels.map((p) => p.id));
    await prisma.item.update({
      where: { id: item.id },
      data: {
        shopifyPublishedAt: new Date(),
        shopifyError: null,
        ...(pastDate ? { shopifyPastDateAppliedAt: new Date() } : {}),
        ...(item.shopifyOnly ? { status: "listed" } : {}),
      },
    });
    return "published";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.item.update({ where: { id: item.id }, data: { shopifyError: message } }).catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Shopify orders -> app records -> eBay
// ---------------------------------------------------------------------------

const ORDER_WATERMARK_KEY = "shopify.lastOrderSyncAt";
// Re-read a little before the last run started, in case Shopify's search
// index lagged behind an order changed right then. Line item ids make the
// overlap harmless.
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;
// A failed eBay push keeps being retried for this long.
const EBAY_PUSH_RETRY_DAYS = 3;
// Whatnot's published seller fees (8% commission, 2.9% + $0.30
// processing). Whatnot keeps the money side to itself, so Shopify never
// sees the real number.
const WHATNOT_FEE_RATE = 0.109;
const WHATNOT_FEE_PER_ORDER = 0.3;

export type ShopifySyncResult = {
  skipped?: string;
  ordersScanned: number;
  salesRecorded: number;
  salesReversed: number;
  refundsRecorded: number;
  ebayPushes: number;
  stockSet: number;
  stockSkipped: number;
  pricesFixed: number;
  // Taken off Whatnot because Whatnot doesn't allow the category.
  offWhatnot: number;
  // Switched over to the past-date page (off every channel but the store).
  pastDateApplied: number;
  archived: number;
  published: number;
  errors: string[];
};

function emptyResult(): ShopifySyncResult {
  return {
    ordersScanned: 0,
    salesRecorded: 0,
    salesReversed: 0,
    refundsRecorded: 0,
    ebayPushes: 0,
    stockSet: 0,
    stockSkipped: 0,
    pricesFixed: 0,
    offWhatnot: 0,
    pastDateApplied: 0,
    archived: 0,
    published: 0,
    errors: [],
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function channelFor(order: ShopifyOrder): string {
  const app = order.appName?.trim() ?? "";
  if (/whatnot/i.test(app) || /whatnot/i.test(order.sourceName ?? "")) return "whatnot";
  if (!app || /^online store$/i.test(app)) return "shopify";
  return app.toLowerCase();
}

// Brings the eBay listing's count down by a recorded Shopify sale. From
// eBay's live count, never the app's own, so an eBay sale the app hasn't
// synced yet stays counted.
async function pushSaleToEbay(saleId: string, result: ShopifySyncResult): Promise<void> {
  const sale = await prisma.shopifySale.findUnique({ where: { id: saleId }, include: { item: true } });
  if (!sale || sale.ebayPushedAt) return;
  const item = sale.item;
  try {
    if (!item.listingEndedAt && (item.ebayOfferId || item.ebayListingId)) {
      const live = await getLiveAvailableQuantity(item);
      if (live == null) throw new Error("Couldn't read the eBay listing's count.");
      const newAvailable = Math.max(0, live - sale.quantity);
      if (item.ebayOfferId) {
        await updateOfferQuantity(item.ebayOfferId, { sku: item.sku, soldQuantity: item.soldQuantity }, newAvailable);
      } else {
        await reviseFixedPriceItemQuantity(item.ebayListingId!, newAvailable);
      }
      result.ebayPushes++;
    }
    await prisma.shopifySale.update({ where: { id: sale.id }, data: { ebayPushedAt: new Date(), ebayPushError: null } });
  } catch (e) {
    const message = errorText(e);
    result.errors.push(`eBay count for ${item.finalTitle ?? item.id} (Shopify order ${sale.shopifyOrderName}): ${message}`);
    await prisma.shopifySale.update({ where: { id: sale.id }, data: { ebayPushError: message } }).catch(() => {});
  }
}

// A cancelled order: the sale comes off the records (its refunds go with
// it, cascade) and, if the eBay count already came down for it, goes back
// up, unless the listing has ended (a returned unit goes on a new listing).
async function reverseShopifySale(
  sale: Prisma.ShopifySaleGetPayload<{ include: { item: true; refunds: true } }>,
  result: ShopifySyncResult
): Promise<void> {
  const item = sale.item;
  const refunded = sale.refunds.reduce((sum, r) => sum + Number(r.amount), 0);
  const newSoldQuantity = Math.max(0, item.soldQuantity - sale.quantity);
  await prisma.$transaction([
    prisma.shopifySale.delete({ where: { id: sale.id } }),
    prisma.item.update({
      where: { id: item.id },
      data: {
        soldQuantity: newSoldQuantity,
        soldRevenueTotal: { decrement: sale.revenue },
        soldFeesTotal: { decrement: sale.fees },
        ...(refunded > 0 ? { refundedTotal: { decrement: refunded } } : {}),
        status: item.status === "sold" && newSoldQuantity < item.quantity ? "listed" : undefined,
      },
    }),
  ]);
  result.salesReversed++;

  if (!sale.ebayPushedAt || item.listingEndedAt || !(item.ebayOfferId || item.ebayListingId)) return;
  try {
    const live = await getLiveAvailableQuantity(item);
    if (live == null) throw new Error("Couldn't read the eBay listing's count.");
    if (item.ebayOfferId) {
      await updateOfferQuantity(item.ebayOfferId, { sku: item.sku, soldQuantity: newSoldQuantity }, live + sale.quantity);
    } else {
      await reviseFixedPriceItemQuantity(item.ebayListingId!, live + sale.quantity);
    }
    result.ebayPushes++;
  } catch (e) {
    result.errors.push(`Putting cancelled Shopify order ${sale.shopifyOrderName} back on eBay: ${errorText(e)}`);
  }
}

async function processOrder(order: ShopifyOrder, result: ShopifySyncResult, changed: Set<string>, pushed: Set<string>) {
  const channel = channelFor(order);
  const orderRevenue = order.lineItems.reduce((sum, li) => sum + li.unitPrice * li.quantity, 0);

  for (const line of order.lineItems) {
    if (!line.variantId) continue;
    try {
      const item = await prisma.item.findUnique({ where: { shopifyVariantId: line.variantId } });
      if (!item) continue;
      const existing = await prisma.shopifySale.findUnique({
        where: { shopifyLineItemId: line.id },
        include: { item: true, refunds: true },
      });

      if (order.cancelledAt) {
        if (existing) {
          await reverseShopifySale(existing, result);
          changed.add(item.id);
        }
        continue;
      }

      const revenue = Math.round(line.unitPrice * line.quantity * 100) / 100;
      const share = orderRevenue > 0 ? revenue / orderRevenue : 1 / order.lineItems.length;
      const whatnot = channel === "whatnot";
      const fees = Math.round((whatnot ? revenue * WHATNOT_FEE_RATE + WHATNOT_FEE_PER_ORDER * share : order.paymentFees * share) * 100) / 100;

      if (existing) {
        // Shopify Payments fees only post once payment is captured, which
        // can be after the order was first recorded.
        const delta = fees - Number(existing.fees);
        if (!existing.feesEstimated && Math.abs(delta) >= 0.005) {
          await prisma.$transaction([
            prisma.shopifySale.update({ where: { id: existing.id }, data: { fees } }),
            prisma.item.update({ where: { id: item.id }, data: { soldFeesTotal: { increment: delta } } }),
          ]);
        }
        continue;
      }

      const newSoldQuantity = item.soldQuantity + line.quantity;
      const [sale] = await prisma.$transaction([
        prisma.shopifySale.create({
          data: {
            itemId: item.id,
            shopifyOrderId: order.id,
            shopifyOrderName: order.name,
            shopifyLineItemId: line.id,
            channel,
            quantity: line.quantity,
            revenue,
            fees,
            feesEstimated: whatnot,
            soldAt: new Date(order.createdAt),
          },
        }),
        prisma.item.update({
          where: { id: item.id },
          data: {
            soldQuantity: { increment: line.quantity },
            soldRevenueTotal: { increment: revenue },
            soldFeesTotal: { increment: fees },
            status: newSoldQuantity >= item.quantity ? "sold" : undefined,
          },
        }),
      ]);
      result.salesRecorded++;
      changed.add(item.id);
      pushed.add(sale.id);
      await pushSaleToEbay(sale.id, result);
    } catch (e) {
      // A unique-key clash means another run recorded this line first.
      if ((e as { code?: string }).code === "P2002") continue;
      result.errors.push(`Shopify order ${order.name} line ${line.id}: ${errorText(e)}`);
    }
  }

  if (order.cancelledAt) return;
  for (const refund of order.refunds) {
    for (const line of refund.lines) {
      try {
        const sale = await prisma.shopifySale.findUnique({ where: { shopifyLineItemId: line.lineItemId } });
        if (!sale || line.amount <= 0) continue;
        const key = `${refund.id}:${line.lineItemId}`;
        if (await prisma.shopifyRefund.findUnique({ where: { shopifyRefundId: key }, select: { id: true } })) continue;
        await prisma.$transaction([
          prisma.shopifyRefund.create({
            data: { saleId: sale.id, shopifyRefundId: key, amount: line.amount, refundedAt: new Date(refund.createdAt) },
          }),
          prisma.item.update({ where: { id: sale.itemId }, data: { refundedTotal: { increment: line.amount } } }),
        ]);
        result.refundsRecorded++;
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") continue;
        result.errors.push(`Shopify order ${order.name} refund ${refund.id}: ${errorText(e)}`);
      }
    }
  }
}

// Reads every order changed since the last run and records it. Returns
// the items whose sold count changed.
async function syncShopifyOrders(result: ShopifySyncResult): Promise<Set<string>> {
  const changed = new Set<string>();
  const pushed = new Set<string>();
  const startedAt = new Date();
  const watermark = await prisma.appSetting.findUnique({ where: { key: ORDER_WATERMARK_KEY } });
  const lastRun = watermark ? new Date(watermark.value) : new Date(startedAt.getTime() - 24 * 60 * 60 * 1000);

  let orders: ShopifyOrder[];
  try {
    orders = await getOrdersUpdatedSince(new Date(lastRun.getTime() - WATERMARK_OVERLAP_MS));
  } catch (e) {
    result.errors.push(`Reading Shopify orders failed: ${errorText(e)}`);
    return changed;
  }
  result.ordersScanned += orders.length;
  const errorsBefore = result.errors.length;
  for (const order of orders) await processOrder(order, result, changed, pushed);
  // A line that failed to record would be a Shopify sale eBay never hears
  // about, so the whole window is read again next run until it goes
  // through (recorded lines are skipped by their line item id).
  const linesFailed = result.errors.length > errorsBefore;

  // Pushes that failed on an earlier run (eBay down, a token hiccup).
  const pending = await prisma.shopifySale.findMany({
    where: {
      ebayPushedAt: null,
      createdAt: { gte: new Date(Date.now() - EBAY_PUSH_RETRY_DAYS * 24 * 60 * 60 * 1000) },
      id: { notIn: [...pushed] },
    },
    select: { id: true },
  });
  for (const sale of pending) await pushSaleToEbay(sale.id, result);

  if (linesFailed) return changed;
  await prisma.appSetting.upsert({
    where: { key: ORDER_WATERMARK_KEY },
    create: { key: ORDER_WATERMARK_KEY, value: startedAt.toISOString() },
    update: { value: startedAt.toISOString() },
  });
  return changed;
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

const LINKED: Prisma.ItemWhereInput = { shopifyInventoryItemId: { not: null }, shopifyArchivedAt: null };

export type ShopifySyncScope = {
  // "all": every product on Shopify (the cron). A list: just those items,
  // after something changed them in this app. Items whose sold count the
  // order sync changes are always included.
  items: "all" | string[];
  // Put items that aren't on Shopify yet up, this many at most per run.
  // retryFailed also retries ones that failed before.
  publish?: { limit: number; retryFailed?: boolean };
};

// Order of steps matters. Shopify's counts are read BEFORE its orders, so
// any Shopify sale already in those counts is also in the app's records by
// the time a count is written; a sale after the read makes the write fail
// as stale. That's what makes it safe to raise a Shopify count (after a
// cancellation or added stock). For items not read up front, or when
// another run had the order sync, counts are only ever lowered, which can
// never cause an oversell.
export async function runShopifySync(scope: ShopifySyncScope): Promise<ShopifySyncResult> {
  const result = emptyResult();
  if (!getShopifyConfig()) {
    result.skipped = "Shopify isn't set up yet.";
    return result;
  }
  try {
    const location = await getLocation();
    const publications = await getPublications();
    const whatnot = publications.find((p) => isWhatnotChannel(p.name));
    const preItems = await prisma.item.findMany({
      where: scope.items === "all" ? LINKED : { ...LINKED, id: { in: scope.items } },
      select: { id: true, shopifyInventoryItemId: true },
    });
    const before = await readStock(preItems.map((i) => i.shopifyInventoryItemId!), location.id, whatnot?.id);

    const orderRun = await withSyncLock("shopify-orders", "quick", () => syncShopifyOrders(result));
    const ordersRan = orderRun.ran;
    const changed = new Set(orderRun.ran ? orderRun.results.flatMap((s) => [...s]) : []);

    const ids = new Set([...preItems.map((i) => i.id), ...changed]);
    const items = await prisma.item.findMany({ where: { ...LINKED, id: { in: [...ids] } } });
    const notReadYet = items.filter((i) => !before.has(i.shopifyInventoryItemId!));
    const lateRead = notReadYet.length
      ? await readStock(notReadYet.map((i) => i.shopifyInventoryItemId!), location.id, whatnot?.id)
      : new Map<string, ShopifyStockState>();
    const discountPct = await getShopifyDiscountPct();
    const paths = await categoryPaths(items.map((i) => i.categoryId));
    const retail = await retailPrices(items);

    for (const item of items) {
      const invId = item.shopifyInventoryItemId!;
      const readFirst = before.has(invId);
      const stock = before.get(invId) ?? lateRead.get(invId);
      const label = item.finalTitle ?? item.id;
      try {
        if (!stock) {
          // Deleted on Shopify by hand: leave it gone.
          await prisma.item.update({
            where: { id: item.id },
            data: { shopifyArchivedAt: new Date(), shopifyError: "The product was deleted on Shopify." },
          });
          continue;
        }
        const target = shopifyTarget(item);
        if (stock.available != null && stock.available !== target) {
          const mayRaise = readFirst && ordersRan;
          if (target < stock.available || mayRaise) {
            const outcome = await setAvailable(invId, location.id, target, stock.available);
            if (outcome === "ok") result.stockSet++;
            else result.stockSkipped++;
          } else {
            result.stockSkipped++;
          }
        }
        if (!isLive(item)) {
          if (stock.productStatus !== "ARCHIVED") await archiveProduct(item.shopifyProductId!);
          await prisma.item.update({ where: { id: item.id }, data: { shopifyArchivedAt: new Date() } });
          result.archived++;
          continue;
        }
        if (item.pastDateAt && !item.shopifyPastDateAppliedAt) {
          await applyPastDate(item, publications);
          result.pastDateApplied++;
        } else if (
          // Also catches products that went up before the rule existed.
          !item.pastDateAt &&
          whatnot &&
          stock.onCheckedChannel &&
          WHATNOT_BLOCKED_CATEGORY.test(paths.get(item.categoryId ?? "") ?? "")
        ) {
          await unpublishFromChannels(item.shopifyProductId!, [whatnot.id]);
          result.offWhatnot++;
        }
        const want = expectedPrices(item, discountPct, retail.get(item.id) ?? null);
        const hasRetailTag = stock.tags.includes(RETAIL_TAG);
        if (want.retailCompare && !hasRetailTag) await addTags(item.shopifyProductId!, [RETAIL_TAG]);
        if (!want.retailCompare && hasRetailTag) await removeTags(item.shopifyProductId!, [RETAIL_TAG]);
        const priceOff = stock.price != null && Math.abs(stock.price - want.price) >= 0.005;
        const compareOff =
          want.compareAt == null ? stock.compareAtPrice != null : stock.compareAtPrice == null || Math.abs(stock.compareAtPrice - want.compareAt) >= 0.005;
        if (item.price != null && (priceOff || compareOff)) {
          await updateVariantPrice(item.shopifyProductId!, item.shopifyVariantId!, want.price, want.compareAt);
          result.pricesFixed++;
        }
      } catch (e) {
        result.errors.push(`${label}: ${errorText(e)}`);
      }
    }

    if (scope.publish) {
      const waiting = await prisma.item.findMany({
        where: { ...waitingForShopifyWhere(), ...(scope.publish.retryFailed ? {} : { shopifyError: null }) },
        orderBy: { createdAt: "asc" },
        take: scope.publish.limit,
        select: { id: true, finalTitle: true },
      });
      for (const w of waiting) {
        try {
          if ((await publishItemToShopify(w.id)) === "published") result.published++;
        } catch (e) {
          result.errors.push(`Listing ${w.finalTitle ?? w.id} on Shopify: ${errorText(e)}`);
        }
      }
    }
  } catch (e) {
    result.errors.push(`Shopify sync failed: ${errorText(e)}`);
  }
  return result;
}

// For routes that just changed an item's stock or price on eBay: brings
// Shopify along once the response has gone out, so the person isn't kept
// waiting on a second store. Anything that fails here is caught up by the
// next 10-minute cron.
export function queueShopifySync(itemIds: string[]): void {
  if (!getShopifyConfig() || itemIds.length === 0) return;
  after(async () => {
    const result = await runShopifySync({ items: itemIds });
    if (result.errors.length) console.error("[shopifySync] queued sync errors", result.errors);
  });
}

// Right after an item goes live on eBay.
export function queueShopifyPublish(itemId: string): void {
  if (!getShopifyConfig()) return;
  after(async () => {
    try {
      await publishItemToShopify(itemId);
    } catch (e) {
      console.error(`[shopifySync] publishing ${itemId} to Shopify failed`, e);
    }
  });
}
