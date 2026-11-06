import { after } from "next/server";
import { descriptionBodyHtml } from "./listingDescription";
import {
  endFixedPriceItem,
  getEbayEnvironment,
  getLiveAvailableQuantity,
  getOfferDetails,
  reviseFixedPriceItemQuantity,
  updateOfferQuantity,
  withdrawOffer,
} from "./ebay";
import { formatExpiration } from "./formatExpiration";
import { parseBundleComponentUnits } from "./itemUnits";
import { prisma } from "./prisma";
import {
  addTags,
  archiveProduct,
  removeTags,
  createProduct,
  ensureTagCollection,
  findProductByHandle,
  listProductSkus,
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

// Keeps the Shopify store in step with eBay. The app's own
// Item.quantity/soldQuantity is the one stock count for every channel.
// Channels: an eBay listing goes on the store and every Shopify sales
// channel EXCEPT Whatnot. Whatnot is listed through Whatnot's own API now
// (whatnotSync.ts, Cristian 2026-11-06): Whatnot-only items never touch
// Shopify, and every run takes anything still on Shopify's Whatnot channel
// off it until that app is disconnected.
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

// Cristian (2026-10-17): the store is the bargain channel. Shopify buyers
// pay their own shipping and there are no eBay fees, so an item goes
// whichever is the bigger discount: ebayPct off the eBay price, or
// retailPct off the manifest retail. Items with no usable retail (listed
// before manifests, bundles, inflated retail) go noRetailPct off eBay.
export type ShopifyPricing = { ebayPct: number; retailPct: number; noRetailPct: number };

const PRICING_KEYS: Record<keyof ShopifyPricing, string> = {
  ebayPct: "shopify_price_discount_pct",
  retailPct: "shopify_retail_discount_pct",
  noRetailPct: "shopify_no_retail_discount_pct",
};
const PRICING_DEFAULTS: ShopifyPricing = { ebayPct: 30, retailPct: 50, noRetailPct: 35 };

export async function getShopifyPricing(): Promise<ShopifyPricing> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(PRICING_KEYS) } } });
  const pricing = { ...PRICING_DEFAULTS };
  for (const field of Object.keys(PRICING_KEYS) as (keyof ShopifyPricing)[]) {
    const value = Number(rows.find((r) => r.key === PRICING_KEYS[field])?.value);
    if (Number.isFinite(value) && value >= 0 && value < 100) pricing[field] = value;
  }
  return pricing;
}

export async function setShopifyPricing(pricing: ShopifyPricing): Promise<void> {
  await prisma.$transaction(
    (Object.keys(PRICING_KEYS) as (keyof ShopifyPricing)[]).map((field) =>
      prisma.appSetting.upsert({
        where: { key: PRICING_KEYS[field] },
        create: { key: PRICING_KEYS[field], value: String(pricing[field]) },
        update: { value: String(pricing[field]) },
      })
    )
  );
}

// What a Whatnot-only listing starts at (Cristian, 2026-11-04: shows start
// everything at $1-2). Filled in as the item's price when it's saved; Review
// can change it per item.
const WHATNOT_START_KEY = "whatnot_start_price";
const WHATNOT_START_DEFAULT = 1;

export async function getWhatnotStartPrice(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: WHATNOT_START_KEY } });
  const value = Number(row?.value);
  return Number.isFinite(value) && value > 0 && value < 10000 ? value : WHATNOT_START_DEFAULT;
}

export async function setWhatnotStartPrice(value: number): Promise<void> {
  const rounded = Math.round(value * 100) / 100;
  await prisma.appSetting.upsert({
    where: { key: WHATNOT_START_KEY },
    create: { key: WHATNOT_START_KEY, value: String(rounded) },
    update: { value: String(rounded) },
  });
}

function pctOff(amount: number, pct: number): number {
  return Math.round(amount * (1 - pct / 100) * 100) / 100;
}

// Supplier manifests sometimes carry inflated "retail" values (a box of
// Nexcare DUO bandages at $21, really $8.99). Pricing off one, or showing
// it as the struck-through price, would be a fake discount, so retail only
// counts when it's at most this many times the original eBay price, which
// is what the item actually goes for. 4x since 2026-10-17: drugstore retail
// runs high next to eBay (Banana Boat Kids Sport, $16.99 a can at CVS, sells
// as a $16.99 4-pack), and bad retail now gets fixed by hand on Review.
export const MAX_RETAIL_TO_EBAY = 4;

export function usableRetail(retail: number | null, ebayOriginal: number): retail is number {
  // In cents, so a retail of exactly 4x isn't lost to float rounding.
  return retail != null && retail > 0 && !(ebayOriginal > 0 && Math.round(retail * 100) > Math.round(ebayOriginal * MAX_RETAIL_TO_EBAY * 100));
}

// The regular store price for a listing at `ebayPrice` (eBay discounts
// included). `retail` is the whole listing's retail (see retailPrices).
export function shopifyPriceFor(
  ebayPrice: number,
  ebayOriginal: number,
  retail: number | null,
  pricing: ShopifyPricing
): number {
  if (!usableRetail(retail, ebayOriginal)) return pctOff(ebayPrice, pricing.noRetailPct);
  // No floor under the eBay price, even when manifest retail is far below
  // it (a $4.06-retail plush listed at $25.99 goes for $2.03). Cristian
  // dropped the 50%-off-eBay floor the same day: he'd rather move volume at
  // a lower profit and grow the store's customers. Every item it touched
  // still cleared a profit after Whatnot fees.
  return Math.min(pctOff(ebayPrice, pricing.ebayPct), pctOff(retail, pricing.retailPct));
}

// Cristian: short-dated and past-date items go 65% off the regular store
// price (the original eBay price, from before any eBay discount, less
// ebayPct). Left on the eBay-only math on purpose when the retail rule
// came in: past-date prices stay as they were.
const PAST_DATE_OFF_PCT = 65;

// The crossed-out price is the item's retail price when there's a
// believable one (see believableRetail), labeled "Retail" by the theme
// through RETAIL_TAG. Without one: past-date items show the regular store
// price crossed out, regular items show none.
export const RETAIL_TAG = "retail-compare";

type ExpectedPrices = { price: number; compareAt: number | null; retailCompare: boolean };

function expectedPrices(
  item: Pick<Item, "price" | "originalPrice" | "pastDateAt">,
  pricing: ShopifyPricing,
  retail: number | null
): ExpectedPrices {
  const original = Number(item.originalPrice ?? item.price ?? 0);
  const regular = pctOff(original, pricing.ebayPct);
  const price = item.pastDateAt
    ? Math.max(0.5, pctOff(regular, PAST_DATE_OFF_PCT))
    : shopifyPriceFor(Number(item.price ?? 0), original, retail, pricing);
  const goodRetail = believableRetail(retail, price, original);
  if (goodRetail != null) return { price, compareAt: goodRetail, retailCompare: true };
  return { price, compareAt: item.pastDateAt ? regular : null, retailCompare: false };
}

// The store price, for Whatnot's cross-listed buy-it-now (Cristian,
// 2026-11-06: "use the Shopify pricing on Whatnot").
export function storePriceFor(item: Pick<Item, "price" | "originalPrice" | "pastDateAt">, pricing: ShopifyPricing, retail: number | null): number {
  return expectedPrices(item, pricing, retail).price;
}

// Retail worth showing: on record, at least 5% above what it sells for
// here (several items sell above manifest retail, since the eBay price
// includes shipping), and not wildly above the original eBay price.
function believableRetail(retail: number | null, price: number, ebayOriginal: number): number | null {
  if (!usableRetail(retail, ebayOriginal) || retail < price * 1.05) return null;
  return Math.round(retail * 100) / 100;
}

// Retail for each item's whole listing (a 3-pack is 3x the unit retail, a
// bundle is the sum of its parts), from its manifest lines. Items scanned
// outside a manifest, and bundles with any part missing a retail, have none.
export async function retailPrices(
  items: Pick<Item, "id" | "manifestId" | "upc" | "isMultipack" | "packSize" | "isBundle" | "bundleComponents">[]
): Promise<Map<string, number>> {
  const parts = (i: (typeof items)[number]) =>
    i.isBundle ? parseBundleComponentUnits(i.bundleComponents) : i.upc ? [{ upc: i.upc, unitsPerBundle: i.isMultipack && i.packSize ? i.packSize : 1 }] : [];
  const wanted = items.filter((i) => i.manifestId && parts(i).length > 0);
  const result = new Map<string, number>();
  if (wanted.length === 0) return result;
  const lines = await prisma.manifestLine.findMany({
    where: { OR: wanted.flatMap((i) => parts(i).map((p) => ({ manifestId: i.manifestId!, upc: p.upc }))) },
    select: { manifestId: true, upc: true, retailPrice: true },
  });
  for (const i of wanted) {
    let total = 0;
    for (const p of parts(i)) {
      const line = lines.find((l) => l.manifestId === i.manifestId && l.upc === p.upc && Number(l.retailPrice) > 0);
      if (!line) {
        total = NaN;
        break;
      }
      total += Number(line.retailPrice) * p.unitsPerBundle;
    }
    if (total > 0) result.set(i.id, total);
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

// Still for sale: live on eBay, or a Shopify-only or Whatnot-only item that's
// been published (or is mid-publish from review, "ready"). Once that's
// over (sold out, expired, ended), the Shopify product is archived too:
// Cristian never restocks a listing.
export function isLive(item: LiveFields): boolean {
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
// Sold-out ones (old CSV listings mostly) don't count: there's nothing to
// put up, and they'd otherwise sit in "waiting" forever.
function waitingForShopifyWhere(): Prisma.ItemWhereInput {
  return {
    status: { in: ["listed", "exported"] },
    quantity: { gt: prisma.item.fields.soldQuantity },
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
    // Whatnot-only listings go up through Whatnot's API, never Shopify.
    whatnotOnly: false,
    finalTitle: { not: null },
    price: { not: null },
    NOT: { photoUrls: { isEmpty: true } },
    // Package says Rx Only: not on the store either (an Rx device sold
    // without a prescription breaks FDA labeling rules). Spelled out as
    // null-or-false: "not true" in SQL drops the nulls (every older item).
    AND: [{ OR: [{ rxOnly: null }, { rxOnly: false }] }],
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

// eBay categories Whatnot doesn't allow (its Prohibited Items policy, read
// 2026-11-06: medicine incl. over-the-counter, medical devices, nicotine and
// vapes, sexual products; see whatnotPolicy.ts). A Whatnot-only listing in
// one is refused at publish. Matched against the item's eBay category path.
// Supplements are handled by whatnotPolicy.ts (approved sellers only).
export const WHATNOT_BLOCKED_CATEGORY =
  /Over-the-Counter Medications|Medical & Mobility|Healthcare, Lab & Dental|Medical, Lab & Dental|Smoking Cessation|Vaping|Sexual Wellness/i;

function isWhatnotChannel(name: string): boolean {
  return /whatnot/i.test(name);
}

// Where a product goes: every channel but Whatnot. Whatnot listings go up
// through Whatnot's own API now (whatnotSync.ts, Cristian 2026-11-06), never
// through Shopify's Whatnot channel.
function channelsFor(publications: { id: string; name: string }[]): { id: string; name: string }[] {
  return publications.filter((p) => !isWhatnotChannel(p.name));
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

export const CONDITION_LABEL: Record<string, string> = {
  new: "New",
  new_other: "New (other)",
  used: "Used",
  for_parts: "For parts or not working",
};

// The description with the same headings and bullets as on eBay
// (listingDescription.ts), minus eBay's "Buying from us" note. Condition and
// expiration are eBay fields with no Shopify equivalent, so they're spelled
// out here.
function shopifyDescription(item: Item): string {
  const body = descriptionBodyHtml(item.finalDescription ?? "");
  const facts: string[] = [];
  if (item.condition) facts.push(`<li><strong>Condition:</strong> ${CONDITION_LABEL[item.condition] ?? item.condition}</li>`);
  if (item.expirationDate) {
    // Several dates: the description already lists each one.
    const label = item.expirationBreakdown ? "Earliest expiration date" : "Expiration date";
    facts.push(`<li><strong>${label}:</strong> ${formatExpiration(item.expirationDate)}</li>`);
  }
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
// it to its channels (channelsFor). Saves the error on the item and
// rethrows when it fails, so Settings can show it and a retry can pick it
// up.
// fromReview: the Publish button on a Shopify-only or Whatnot-only item, which
// is still "ready" until this succeeds and flips it to "listed".
// Re-sends just the description to the item's Shopify product (2026-10-25:
// live listings moved to the sectioned layout). Same text the publish
// writes, past-date notice included. False when it isn't on Shopify.
export async function refreshShopifyDescription(item: Item): Promise<boolean> {
  if (!item.shopifyProductId) return false;
  const body = shopifyDescription(item);
  await updateDescription(item.shopifyProductId, item.pastDateAt ? pastDateDisclosure(item) + body : body);
  return true;
}

export async function publishItemToShopify(itemId: string, options?: { fromReview?: boolean }): Promise<PublishOutcome> {
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item) throw new Error("Item not found.");
  const where = waitingForShopifyWhere();
  const eligible = await prisma.item.count({
    where: options?.fromReview
      ? { ...where, id: itemId, shopifyOnly: true, status: "ready", OR: undefined }
      : { ...where, id: itemId },
  });
  if (!eligible || item.whatnotOnly) return "not_eligible";

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

    const [location, pricing, category] = await Promise.all([
      getLocation(),
      getShopifyPricing(),
      item.categoryId ? prisma.ebayCategory.findUnique({ where: { id: item.categoryId } }) : null,
    ]);
    const specifics = (item.itemSpecifics ?? {}) as Record<string, string>;
    const handle = shopifyHandle(item);
    const weightLbs = (item.weightLbs ?? 0) + (item.weightOz ?? 0) / 16;
    // A past-date item goes up already in its past-date state: price,
    // disclosure, tags and Online Store only, never a moment at full price.
    const pastDate = Boolean(item.pastDateAt);
    const prices = expectedPrices(item, pricing, (await retailPrices([item])).get(item.id) ?? null);
    const tags = item.condition ? [`Condition: ${CONDITION_LABEL[item.condition] ?? item.condition}`] : [];
    if (prices.retailCompare) tags.push(RETAIL_TAG);
    if (pastDate) {
      tags.push(PAST_DATE_TAG);
      if (item.expirationDate) tags.push(`Best by: ${formatExpiration(item.expirationDate)}`);
    }

    const publications = await getPublications();
    let channels: { id: string; name: string }[];
    if (pastDate) {
      const onlineStore = publications.find((p) => /^online store$/i.test(p.name));
      if (!onlineStore) throw new Error("No Online Store channel found to put the past-date item on.");
      channels = [onlineStore];
    } else {
      channels = channelsFor(publications);
    }

    // Already made on an earlier try that failed before publishing: reuse
    // it, even if the title (and so the handle) changed since.
    const saved =
      item.shopifyProductId && item.shopifyVariantId && item.shopifyInventoryItemId
        ? { productId: item.shopifyProductId, variantId: item.shopifyVariantId, inventoryItemId: item.shopifyInventoryItemId }
        : null;
    const existing = saved ?? (await findProductByHandle(handle));
    const refs =
      existing ??
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

    // A reused product may carry an older price (another lane's, even):
    // set this lane's before it goes on any channel.
    if (existing) await updateVariantPrice(refs.productId, refs.variantId, prices.price, prices.compareAt);
    if (pastDate) {
      await ensureTagCollection({ ...PAST_DATE_COLLECTION, tag: PAST_DATE_TAG, publicationIds: [channels[0].id] });
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
  // eBay / store products taken off the Whatnot channel (only Whatnot-only
  // listings belong there, since 2026-11-04).
  offWhatnot: number;
  // Switched over to the past-date page (off every channel but the store).
  pastDateApplied: number;
  // Not reached before the time budget ran out; the next run does them.
  leftForNextRun: number;
  // Extra copies of a listing (same SKU, not the product the item is
  // linked to) archived so they can't sell untracked.
  duplicatesArchived: number;
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
    leftForNextRun: 0,
    duplicatesArchived: 0,
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
// A failed push used to wait for the next 10-minute cron (Cristian,
// 2026-11-05: Shopify #1228 sold the last unit at 5:43 PM and the eBay
// listing stayed buyable until 5:50). A fresh sale now tries again within
// seconds; a push still pending from an earlier run gets one try per run.
const EBAY_PUSH_ATTEMPTS = 3;
const EBAY_PUSH_RETRY_WAIT_MS = 2_000;

async function pushSaleToEbay(saleId: string, result: ShopifySyncResult, attempts = 1): Promise<void> {
  const sale = await prisma.shopifySale.findUnique({ where: { id: saleId }, include: { item: true } });
  if (!sale || sale.ebayPushedAt) return;
  // The count eBay should end up at, worked out once from the first live
  // read. A retry writes the same number, and skips the write when eBay is
  // already there or lower, so a call that failed after eBay applied it
  // can't take the unit off twice.
  let target: number | null = null;
  let lastError: unknown = null;
  let pushed = false;
  for (let attempt = 1; attempt <= attempts && !pushed; attempt++) {
    // Re-read on a retry: another run may have ended the listing meanwhile.
    const item = attempt === 1 ? sale.item : ((await prisma.item.findUnique({ where: { id: sale.itemId } })) ?? sale.item);
    try {
      // Already ended on eBay (an earlier attempt's withdraw went through
      // but recording it didn't): record it now, nothing left to change.
      const offer = !item.listingEndedAt && item.ebayOfferId ? await getOfferDetails(item.ebayOfferId) : null;
      if (offer?.offerStatus === "UNPUBLISHED") {
        await prisma.item.update({ where: { id: item.id }, data: { listingEndedAt: new Date() } });
      } else if (!item.listingEndedAt && (item.ebayOfferId || item.ebayListingId)) {
        const live = item.ebayOfferId ? (offer?.availableQuantity ?? null) : await getLiveAvailableQuantity(item);
        if (live == null) throw new Error("Couldn't read the eBay listing's count.");
        if (target == null) target = Math.max(0, live - sale.quantity);
        if (live > target) {
          if (target === 0) {
            // The last one sold: end the listing. The account has eBay's
            // Out-of-stock control off, so eBay never lets a listing sit at
            // 0 ("The quantity must be a valid number greater than 0",
            // Shopify #1225, #1228, #1229). Cristian, 2026-11-06: end it
            // straight away. If the order is cancelled, the unit goes on a
            // new listing from the Returns page (cancelledOrders.ts).
            // Only when the app agrees it's sold out: the two counts have
            // disagreed before (20 on eBay vs 19 here). Otherwise the
            // listing stays up and the mismatch shows as an error.
            const fresh = await prisma.item.findUnique({ where: { id: item.id }, select: { quantity: true, soldQuantity: true } });
            const appLeft = fresh ? fresh.quantity - fresh.soldQuantity : null;
            if (appLeft == null || appLeft > 0) {
              throw new Error(`eBay would be sold out but the app shows ${appLeft ?? "?"} left, so the listing was left up. Check the count.`);
            }
            if (item.ebayOfferId) await withdrawOffer(item.ebayOfferId);
            else await endFixedPriceItem(item.ebayListingId!);
            await prisma.item.update({ where: { id: item.id }, data: { listingEndedAt: new Date() } });
          } else if (item.ebayOfferId) {
            await updateOfferQuantity(item.ebayOfferId, { sku: item.sku, soldQuantity: item.soldQuantity }, target);
          } else {
            await reviseFixedPriceItemQuantity(item.ebayListingId!, target);
          }
          result.ebayPushes++;
        }
      }
      pushed = true;
    } catch (e) {
      lastError = e;
      console.error(`[shopifySync] eBay push attempt ${attempt}/${attempts} for Shopify ${sale.shopifyOrderName}`, e);
      if (attempt < attempts) await new Promise((r) => setTimeout(r, EBAY_PUSH_RETRY_WAIT_MS * attempt));
    }
  }
  if (pushed) {
    await prisma.shopifySale
      .update({ where: { id: sale.id }, data: { ebayPushedAt: new Date(), ebayPushError: null } })
      .catch((e) => result.errors.push(`Shopify order ${sale.shopifyOrderName}: eBay updated, but marking it done failed: ${errorText(e)}`));
    return;
  }
  const message = errorText(lastError);
  result.errors.push(`eBay count for ${sale.item.finalTitle ?? sale.item.id} (Shopify order ${sale.shopifyOrderName}): ${message}`);
  await prisma.shopifySale.update({ where: { id: sale.id }, data: { ebayPushError: message } }).catch(() => {});
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
  // The listing already ended because this sale sold it out: the unit is
  // back but has nowhere to sell, so it waits on the Returns page to be
  // relisted as a new listing. Flagged in the same transaction as the
  // reversal, so it can't be lost. Loaded here, not at the top: the
  // returns code imports stockAdjust, which imports this file.
  const cancelled = await import("./warehouse/cancelledOrders");
  const flag = cancelled.strandedByCancel(item)
    ? await cancelled.cancelledReturnData({
        itemId: item.id,
        channel: "shopify",
        orderName: sale.shopifyOrderName,
        lineItemId: sale.shopifyLineItemId,
        units: sale.quantity,
      })
    : null;
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
    ...(flag ? [prisma.itemReturn.create({ data: flag })] : []),
  ]);
  result.salesReversed++;

  // An ended listing stays ended (Cristian never restocks a listing).
  if (item.listingEndedAt) return;
  if (!sale.ebayPushedAt || !(item.ebayOfferId || item.ebayListingId)) return;
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
      await pushSaleToEbay(sale.id, result, EBAY_PUSH_ATTEMPTS);
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

// A Vercel function gets 5 minutes; the eBay sync runs first in the same
// cron call, so the Shopify pass keeps well under what's left.
const SYNC_BUDGET_MS = 150_000;
// Products worked on at once. Shopify's rate limit handles a few in
// parallel easily (and shopifyGraphql waits out any throttling).
const ITEM_CONCURRENCY = 5;

// Runs fn over list, `concurrency` at a time, starting no new one after
// `deadline`. Returns how many were left unstarted.
async function eachUntil<T>(list: T[], concurrency: number, deadline: number, fn: (t: T) => Promise<void>): Promise<number> {
  let next = 0;
  const worker = async () => {
    while (next < list.length && Date.now() < deadline) await fn(list[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return list.length - next;
}

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
  const deadline = Date.now() + SYNC_BUDGET_MS;
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
    const pricing = await getShopifyPricing();
    const retail = await retailPrices(items);

    const fixItem = async (item: (typeof items)[number]) => {
      const invId = item.shopifyInventoryItemId!;
      const readFirst = before.has(invId);
      const stock = before.get(invId) ?? lateRead.get(invId);
      const label = item.finalTitle ?? item.id;
      try {
        if (!stock) {
          // Deleted on Shopify by hand: that's a choice, not a problem.
          // Leave it gone and don't put it back up.
          await prisma.item.update({ where: { id: item.id }, data: { shopifyArchivedAt: new Date(), shopifyError: null } });
          return;
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
          return;
        }
        if (item.pastDateAt && !item.shopifyPastDateAppliedAt) {
          await applyPastDate(item, publications);
          result.pastDateApplied++;
        } else if (whatnot && stock.onCheckedChannel) {
          // Nothing goes on Whatnot through Shopify any more (Whatnot's own
          // API lists them, whatnotSync.ts): takes anything still on the
          // Shopify Whatnot channel off it, until that app is disconnected.
          await unpublishFromChannels(item.shopifyProductId!, [whatnot.id]);
          result.offWhatnot++;
        }
        const want = expectedPrices(item, pricing, retail.get(item.id) ?? null);
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
    };
    // Several products at once, and stop with time to spare: a run that
    // has to touch every product (the discount changed, say) used to hit
    // the 5-minute limit partway and leave the rest on old prices. Whatever
    // is left gets done by the next run.
    result.leftForNextRun += await eachUntil(items, ITEM_CONCURRENCY, deadline, fixItem);

    if (scope.items === "all") await archiveDuplicates(result);

    // One publisher at a time: the cron and Settings' "Send waiting items
    // now" running together both took the same waiting items and each made
    // its own product. Whichever comes second just skips this step.
    const publishRun = scope.publish
      ? await withSyncLock("shopify-publish", "quick", async () => {
          await publishWaiting(scope.publish!, deadline, result);
        })
      : null;
    if (publishRun && !publishRun.ran) result.errors.push("Another run was already putting items on Shopify; skipped here.");

    // Whatnot hears about every stock change Shopify does (a sale on eBay
    // or Shopify, a count fix, a discount): its counts and buy-it-now
    // prices follow (whatnotSync.ts). The cron covers everything else.
    // Loaded here: whatnotSync imports this file.
    // Every item asked about, not just those on Shopify (a Whatnot-only
    // item's count changed by hand, say).
    if (scope.items !== "all") {
      const whatnotIds = [...new Set([...ids, ...scope.items])];
      if (whatnotIds.length > 0) {
        const whatnot = await import("./whatnotSync");
        result.errors.push(...(await whatnot.syncWhatnotStock(whatnotIds)));
      }
    }
  } catch (e) {
    result.errors.push(`Shopify sync failed: ${errorText(e)}`);
  }
  return result;
}

// A Whatnot sale (whatnotSync.ts), recorded like a Shopify one: a
// ShopifySale with channel "whatnot", keyed "whatnot:<order item id>", the
// app's sold count up, and eBay's count brought down at once. A cancelled
// Whatnot order takes it back off. Fees are estimated from Whatnot's
// published rates (8% + 2.9% + $0.30 an order); Whatnot doesn't send them.
export async function recordWhatnotSale(args: {
  itemId: string;
  orderId: string;
  orderItemId: string;
  quantity: number;
  revenue: number;
  // This line's share of the order (for the per-order fee).
  orderShare: number;
  soldAt: Date;
  cancelled: boolean;
}): Promise<{ changed: boolean; errors: string[] }> {
  const result = emptyResult();
  const lineKey = `whatnot:${args.orderItemId}`;
  const existing = await prisma.shopifySale.findUnique({
    where: { shopifyLineItemId: lineKey },
    include: { item: true, refunds: true },
  });
  if (args.cancelled) {
    if (!existing) return { changed: false, errors: [] };
    await reverseShopifySale(existing, result);
    return { changed: true, errors: result.errors };
  }
  if (existing) return { changed: false, errors: [] };
  const item = await prisma.item.findUnique({ where: { id: args.itemId } });
  if (!item) return { changed: false, errors: [] };
  const revenue = Math.round(args.revenue * 100) / 100;
  const fees = Math.round((revenue * WHATNOT_FEE_RATE + WHATNOT_FEE_PER_ORDER * args.orderShare) * 100) / 100;
  try {
    const newSoldQuantity = item.soldQuantity + args.quantity;
    const [sale] = await prisma.$transaction([
      prisma.shopifySale.create({
        data: {
          itemId: item.id,
          shopifyOrderId: `whatnot:${args.orderId}`,
          shopifyOrderName: `Whatnot ${args.orderId.slice(0, 8)}`,
          shopifyLineItemId: lineKey,
          channel: "whatnot",
          quantity: args.quantity,
          revenue,
          fees,
          feesEstimated: true,
          soldAt: args.soldAt,
        },
      }),
      prisma.item.update({
        where: { id: item.id },
        data: {
          soldQuantity: { increment: args.quantity },
          soldRevenueTotal: { increment: revenue },
          soldFeesTotal: { increment: fees },
          status: newSoldQuantity >= item.quantity ? "sold" : undefined,
          // Whatnot already took these off its own count.
          ...(item.whatnotQuantity != null ? { whatnotQuantity: { decrement: args.quantity } } : {}),
        },
      }),
    ]);
    // eBay at once, like a Shopify sale (a Whatnot-only item has no eBay
    // listing: nothing to push, it's just marked done).
    await pushSaleToEbay(sale.id, result, EBAY_PUSH_ATTEMPTS);
    return { changed: true, errors: result.errors };
  } catch (e) {
    // Another delivery of the same order recorded it first.
    if ((e as { code?: string }).code === "P2002") return { changed: false, errors: [] };
    throw e;
  }
}

async function publishWaiting(
  publish: NonNullable<ShopifySyncScope["publish"]>,
  deadline: number,
  result: ShopifySyncResult
): Promise<void> {
  const waiting = await prisma.item.findMany({
    where: { ...waitingForShopifyWhere(), ...(publish.retryFailed ? {} : { shopifyError: null }) },
    orderBy: { createdAt: "asc" },
    take: publish.limit,
    select: { id: true, finalTitle: true },
  });
  for (const w of waiting) {
    if (Date.now() > deadline) {
      result.leftForNextRun++;
      continue;
    }
    try {
      if ((await publishItemToShopify(w.id)) === "published") result.published++;
    } catch (e) {
      result.errors.push(`Listing ${w.finalTitle ?? w.id} on Shopify: ${errorText(e)}`);
    }
  }
}

// Extra Shopify copies of one listing: a product whose SKU belongs to an
// item that's linked to a different product. The app doesn't track the
// copy, so a sale of it would never come off eBay. Archived, not deleted,
// so nothing is lost if one turns out to be wanted.
async function archiveDuplicates(result: ShopifySyncResult): Promise<void> {
  const products = await listProductSkus();
  const skus = [...new Set(products.map((p) => p.sku).filter((s): s is string => Boolean(s)))];
  if (skus.length === 0) return;
  const items = await prisma.item.findMany({
    where: { sku: { in: skus }, shopifyProductId: { not: null } },
    select: { sku: true, shopifyProductId: true, finalTitle: true },
  });
  const linkedBySku = new Map(items.map((i) => [i.sku, i]));
  for (const p of products) {
    const item = p.sku ? linkedBySku.get(p.sku) : undefined;
    if (!item || item.shopifyProductId === p.id || p.status === "ARCHIVED") continue;
    try {
      await archiveProduct(p.id);
      result.duplicatesArchived++;
    } catch (e) {
      result.errors.push(`Archiving a duplicate of ${item.finalTitle ?? item.sku}: ${errorText(e)}`);
    }
  }
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
      // Same lock as the cron's publish step, so the two never both make a
      // product for this item; if it's busy, the cron puts this one up.
      await withSyncLock("shopify-publish", "quick", async () => {
        await publishItemToShopify(itemId);
      });
    } catch (e) {
      console.error(`[shopifySync] publishing ${itemId} to Shopify failed`, e);
    }
  });
}
