import { randomUUID } from "node:crypto";
import type { Item } from "@/generated/prisma/client";
import { formatExpiration } from "./formatExpiration";
import { prisma } from "./prisma";
import {
  CONDITION_LABEL,
  getShopifyPricing,
  getWhatnotStartPrice,
  isLive,
  recordWhatnotSale,
  retailPrices,
  runShopifySync,
  storePriceFor,
  WHATNOT_BLOCKED_CATEGORY,
} from "./shopifySync";
import { withSyncLock } from "./syncLock";
import {
  adjustInventory,
  createProduct,
  deleteProduct,
  getOrder,
  listOrderItems,
  listOrders,
  listProducts,
  listVariants,
  merchandise,
  setInventory,
  updateVariant,
  whatnotConfigured,
  WhatnotError,
} from "./whatnot";
import { allowedByOwner, supplementsApproved, whatnotBanReason, whatnotDaysNeeded } from "./whatnotPolicy";

// Whatnot through its own Seller API (Cristian, 2026-11-06), replacing the
// Shopify app channel:
// - Whatnot-only items (Item.whatnotOnly) go up as auctions at the start
//   price ($1, Settings), sold only in shows: the show their Whatnot bin is
//   assigned to on the Whatnot page (BinShow).
// - Everything live on eBay/Shopify is cross-listed as buy-it-now in the
//   Whatnot shop at the store price (when the Whatnot page's switch is on),
//   except what Whatnot doesn't allow (whatnotPolicy.ts) or what's too close
//   to its date. Those are skipped, with the reason kept.
// - One stock count: a Whatnot sale is recorded like a Shopify one
//   (recordWhatnotSale) and taken off eBay and Shopify at once; an eBay or
//   Shopify sale brings Whatnot's count down (syncWhatnotStock, called from
//   every Shopify sync). Sold out or no longer live = taken off Whatnot.

const CATEGORY_MAP_KEY = "whatnot.categoryMap";
const CROSS_LIST_KEY = "whatnot.crossList";
const ORDERS_CHECKED_KEY = "whatnot.ordersCheckedAt";

export type CategoryRule = { match: string; categoryId: string; categoryName: string };
export type CategoryMap = { rules: CategoryRule[]; defaultId: string | null; defaultName: string | null };

export async function getCategoryMap(): Promise<CategoryMap> {
  const row = await prisma.appSetting.findUnique({ where: { key: CATEGORY_MAP_KEY } });
  try {
    const parsed = row ? (JSON.parse(row.value) as Partial<CategoryMap>) : {};
    return {
      rules: Array.isArray(parsed.rules) ? parsed.rules.filter((r) => r && r.match && r.categoryId) : [],
      defaultId: parsed.defaultId ?? null,
      defaultName: parsed.defaultName ?? null,
    };
  } catch {
    return { rules: [], defaultId: null, defaultName: null };
  }
}

export async function setCategoryMap(map: CategoryMap): Promise<void> {
  const value = JSON.stringify(map);
  await prisma.appSetting.upsert({ where: { key: CATEGORY_MAP_KEY }, create: { key: CATEGORY_MAP_KEY, value }, update: { value } });
  // Items skipped only for want of a category get another look.
  await prisma.item.updateMany({ where: { whatnotSkipReason: { startsWith: NO_CATEGORY } }, data: { whatnotSkipReason: null } });
}

export async function getCrossList(): Promise<boolean> {
  return (await prisma.appSetting.findUnique({ where: { key: CROSS_LIST_KEY } }))?.value === "1";
}

export async function setCrossList(on: boolean): Promise<void> {
  const value = on ? "1" : "0";
  await prisma.appSetting.upsert({ where: { key: CROSS_LIST_KEY }, create: { key: CROSS_LIST_KEY, value }, update: { value } });
}

const NO_CATEGORY = "No Whatnot category for eBay category: ";

// The first rule whose text appears in the eBay category path, else the
// default.
function categoryFor(path: string | null, map: CategoryMap): { id: string } | null {
  const p = (path ?? "").toLowerCase();
  const rule = map.rules.find((r) => p.includes(r.match.toLowerCase()));
  if (rule) return { id: rule.categoryId };
  return map.defaultId ? { id: map.defaultId } : null;
}

function description(item: Item): string {
  const lines = [(item.finalDescription ?? "").trim()];
  if (item.condition) lines.push(`Condition: ${CONDITION_LABEL[item.condition] ?? item.condition}`);
  if (item.expirationDate) {
    lines.push(`${item.expirationBreakdown ? "Earliest expiration date" : "Expiration date"}: ${formatExpiration(item.expirationDate)}`);
  }
  return lines.filter(Boolean).join("\n\n").slice(0, 5000);
}

function packageWeightOz(item: Item): number {
  return (item.weightLbs ?? 0) * 16 + (item.weightOz ?? 0);
}

async function boxDimensions(label: string | null): Promise<{ length: number; width: number; height: number } | null> {
  if (!label) return null;
  const box = await prisma.boxSize.findUnique({ where: { label }, select: { lengthIn: true, widthIn: true, heightIn: true } });
  if (!box?.lengthIn || !box.widthIn || !box.heightIn) return null;
  return { length: Number(box.lengthIn), width: Number(box.widthIn), height: Number(box.heightIn) };
}

// Why it can't go on Whatnot, or null. Same rules as the List page, on the
// listing's own title and eBay category, unless Cristian allowed it.
async function whatnotProblem(item: Item, categoryPath: string | null): Promise<string | null> {
  const title = item.finalTitle ?? item.aiTitle ?? "";
  if (!title) return "No title yet";
  if (item.photoUrls.length === 0) return "No photos";
  if (packageWeightOz(item) <= 0) return "No weight";
  if (item.localPickupOnly) return "Local pickup only";
  if (item.rxOnly) return "Rx only";
  const banned = WHATNOT_BLOCKED_CATEGORY.test(categoryPath ?? "")
    ? "Whatnot doesn't allow medicine or medical supplies."
    : whatnotBanReason(title, categoryPath, { supplementsOk: await supplementsApproved() });
  if (banned && !(item.upc && (await allowedByOwner(item.upc, title)))) return banned;
  const days = whatnotDaysNeeded(title);
  if (item.expirationDate && item.expirationDate.getTime() < Date.now() + days * 24 * 60 * 60 * 1000) {
    return `Less than ${days} days before its date`;
  }
  return null;
}

async function categoryPathOf(item: Item): Promise<string | null> {
  if (!item.categoryId) return null;
  return (await prisma.ebayCategory.findUnique({ where: { id: item.categoryId }, select: { path: true } }))?.path ?? null;
}

// The show its auction belongs in: its Whatnot bin's show.
async function showForItem(itemId: string): Promise<{ showId: string } | null> {
  const content = await prisma.binContent.findFirst({
    where: { itemId, bin: { show: { isNot: null } } },
    select: { bin: { select: { show: { select: { showId: true } } } } },
  });
  return content?.bin.show ? { showId: content.bin.show.showId } : null;
}

// Makes (or finishes making) the Whatnot listing. Each step is saved as it
// goes, so a retry after a failure picks up the same product.
async function putOnWhatnot(
  item: Item,
  format: "auction" | "buy_it_now",
  price: number,
  quantity: number,
  categoryId: string
): Promise<void> {
  let productId = item.whatnotProductId;
  // An earlier try may have made the product and then lost the answer (a
  // timeout): adopt it instead of making a second, which would stay
  // buyable after the unit sold elsewhere. Newest first, so it's near the
  // top. whatnotFormat is set before the first create as the marker.
  if (!productId && item.whatnotFormat) {
    let cursor: string | undefined;
    for (let page = 0; page < 3 && !productId; page++) {
      const res = await listProducts(cursor);
      productId = res.items.find((p) => p.external_id === item.sku)?.id ?? null;
      if (!res.next) break;
      cursor = res.next;
    }
    if (productId) await prisma.item.update({ where: { id: item.id }, data: { whatnotProductId: productId } });
  }
  if (!productId) {
    await prisma.item.update({ where: { id: item.id }, data: { whatnotFormat: format } });
    const product = await createProduct({
      title: (item.finalTitle ?? item.aiTitle ?? item.sku).slice(0, 200),
      description: description(item),
      externalId: item.sku,
      categoryId,
      imageUrls: item.photoUrls.slice(0, 10),
      weightOz: packageWeightOz(item),
      dimensions: await boxDimensions(item.boxSize),
    });
    productId = product.id;
    await prisma.item.update({ where: { id: item.id }, data: { whatnotProductId: productId } });
  }
  let variantId = item.whatnotVariantId;
  if (!variantId) {
    const variants = await listVariants(productId);
    if (variants.length !== 1) throw new Error(`Whatnot made ${variants.length} variants for it; expected 1.`);
    variantId = variants[0].id;
    await prisma.item.update({ where: { id: item.id }, data: { whatnotVariantId: variantId } });
  }
  // Sale format first: the price applies under it.
  await merchandise(productId, { transactionType: format, ...(format === "buy_it_now" ? { reserveForLive: false } : {}) });
  await updateVariant(productId, { id: variantId, sku: item.sku, externalId: item.sku, price });
  await setInventory(variantId, quantity, randomUUID());
  const show = format === "auction" ? await showForItem(item.id) : null;
  if (show) await merchandise(productId, { shows: { strategy: "REPLACE", showIds: [show.showId] } });
  await prisma.item.update({
    where: { id: item.id },
    data: {
      whatnotFormat: format,
      whatnotPrice: price,
      whatnotQuantity: quantity,
      whatnotPublishedAt: new Date(),
      whatnotEndedAt: null,
      whatnotShowId: show?.showId ?? null,
      whatnotError: null,
      whatnotSkipReason: null,
    },
  });
}

// Review's Publish on a Whatnot-only item: an auction at its start price.
export async function publishWhatnotOnlyItem(itemId: string): Promise<void> {
  if (!whatnotConfigured()) throw new Error("Whatnot isn't connected yet. Add the API token in Vercel first.");
  const item = await prisma.item.findUnique({ where: { id: itemId } });
  if (!item || !item.whatnotOnly) throw new Error("This isn't a Whatnot listing.");
  const left = item.quantity - item.soldQuantity;
  if (left <= 0) throw new Error("There's no stock left on this item to sell.");
  const path = await categoryPathOf(item);
  const problem = await whatnotProblem(item, path);
  if (problem) throw new Error(`${problem}. Set it aside for donation.`);
  const category = categoryFor(path, await getCategoryMap());
  if (!category) throw new Error(`${NO_CATEGORY}${path ?? "none"}. Set one on the Whatnot page.`);
  const price = Number(item.price ?? (await getWhatnotStartPrice()));
  try {
    await putOnWhatnot(item, "auction", price, left, category.id);
    await prisma.item.update({ where: { id: item.id }, data: { status: "listed" } });
  } catch (e) {
    await prisma.item.update({ where: { id: item.id }, data: { whatnotError: errorText(e) } }).catch(() => {});
    throw e;
  }
}

// Live eBay/Shopify items not on Whatnot yet, oldest first.
async function crossListWaiting(limit: number, deadline: number, errors: string[]): Promise<number> {
  if (!(await getCrossList())) return 0;
  const candidates = await prisma.item.findMany({
    where: {
      whatnotOnly: false,
      whatnotProductId: null,
      whatnotSkipReason: null,
      whatnotError: null,
      status: { in: ["listed", "exported"] },
      quantity: { gt: prisma.item.fields.soldQuantity },
      expiredAt: null,
      pastDateAt: null,
      listingEndedAt: null,
      price: { not: null },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const [map, pricing] = await Promise.all([getCategoryMap(), getShopifyPricing()]);
  const retail = await retailPrices(candidates);
  let listed = 0;
  for (const item of candidates) {
    if (Date.now() > deadline) break;
    if (!isLive(item)) continue;
    const path = await categoryPathOf(item);
    const problem = await whatnotProblem(item, path);
    const category = problem ? null : categoryFor(path, map);
    if (problem || !category) {
      await prisma.item.update({
        where: { id: item.id },
        data: { whatnotSkipReason: problem ?? `${NO_CATEGORY}${path ?? "none"}` },
      });
      continue;
    }
    try {
      const price = storePriceFor(item, pricing, retail.get(item.id) ?? null);
      await putOnWhatnot(item, "buy_it_now", price, item.quantity - item.soldQuantity, category.id);
      listed++;
    } catch (e) {
      const message = errorText(e);
      errors.push(`Listing ${item.finalTitle ?? item.sku} on Whatnot: ${message}`);
      await prisma.item.update({ where: { id: item.id }, data: { whatnotError: message } }).catch(() => {});
    }
  }
  return listed;
}

// Brings Whatnot's count (and a cross-listed item's price) in line with the
// app's. Sold out or no longer live = taken off Whatnot. Returns errors.
export async function syncWhatnotStock(scope: string[] | "all"): Promise<string[]> {
  if (!whatnotConfigured()) return [];
  const errors: string[] = [];
  const items = await prisma.item.findMany({
    where: {
      whatnotVariantId: { not: null },
      whatnotPublishedAt: { not: null },
      whatnotEndedAt: null,
      ...(scope === "all" ? {} : { id: { in: scope } }),
    },
  });
  if (items.length === 0) return errors;
  const pricing = await getShopifyPricing();
  const retail = await retailPrices(items.filter((i) => !i.whatnotOnly));
  for (const item of items) {
    try {
      const left = Math.max(0, item.quantity - item.soldQuantity);
      const live = item.whatnotOnly ? item.status === "listed" && !item.expiredAt : isLive(item) && !item.pastDateAt;
      const target = live ? left : 0;
      if (target === 0) {
        await setInventory(item.whatnotVariantId!, 0, randomUUID());
        // Gone for good: delete it. Whatnot refuses (409) while an order
        // holds it; at 0 it can't sell anyway.
        await deleteProduct(item.whatnotProductId!).catch((e) => {
          if (!(e instanceof WhatnotError && (e.status === 409 || e.status === 404))) throw e;
        });
        await prisma.item.update({ where: { id: item.id }, data: { whatnotQuantity: 0, whatnotEndedAt: new Date() } });
        continue;
      }
      // By the difference, never an absolute count: a Whatnot sale not
      // recorded yet has already lowered Whatnot's own count, and setting
      // a number would put that unit back up for sale. whatnotQuantity is
      // claimed first (only if nobody changed it meanwhile), so two runs
      // can't both send the same change.
      const last = item.whatnotQuantity ?? 0;
      if (target !== last) {
        const claim = await prisma.item.updateMany({
          where: { id: item.id, whatnotQuantity: item.whatnotQuantity },
          data: { whatnotQuantity: target },
        });
        if (claim.count === 1) {
          try {
            await adjustInventory(item.whatnotVariantId!, target - last, randomUUID());
          } catch (e) {
            await prisma.item.updateMany({ where: { id: item.id, whatnotQuantity: target }, data: { whatnotQuantity: last } });
            throw e;
          }
        }
      }
      if (item.whatnotFormat === "buy_it_now") {
        const price = storePriceFor(item, pricing, retail.get(item.id) ?? null);
        if (item.whatnotPrice == null || Math.abs(Number(item.whatnotPrice) - price) >= 0.005) {
          await updateVariant(item.whatnotProductId!, { id: item.whatnotVariantId!, price });
          await prisma.item.update({ where: { id: item.id }, data: { whatnotPrice: price } });
        }
      }
    } catch (e) {
      errors.push(`Whatnot count for ${item.finalTitle ?? item.sku}: ${errorText(e)}`);
    }
  }
  return errors;
}

// One Whatnot order: each line it can match to a listing is recorded (or,
// cancelled, taken back), then eBay and Shopify are brought in line.
export async function processWhatnotOrder(orderId: string): Promise<{ changed: string[]; errors: string[] }> {
  const errors: string[] = [];
  const changed = new Set<string>();
  const order = await getOrder(orderId);
  const lines = await listOrderItems(orderId);
  const amount = (m: { amount: string } | null | undefined) => Number(m?.amount ?? 0);
  const orderTotal = lines.reduce((sum, l) => sum + amount(l.unit_price) * l.quantity, 0);
  for (const line of lines) {
    // Only listings this app put on Whatnot through the API: by the ids
    // Whatnot gave it, or by SKU for one of those. Orders from the old
    // Shopify Whatnot channel carry the same SKUs but were already recorded
    // as Shopify orders; matching them would count the sale twice and could
    // end a live eBay listing.
    const sku = line.variant_external_id ?? line.product_external_id;
    const ids = [
      ...(line.variant_id ? [{ whatnotVariantId: line.variant_id }] : []),
      ...(line.product_id ? [{ whatnotProductId: line.product_id }] : []),
    ];
    const item =
      (ids.length ? await prisma.item.findFirst({ where: { OR: ids }, select: { id: true, whatnotPublishedAt: true } }) : null) ??
      (sku
        ? await prisma.item.findFirst({ where: { sku, whatnotPublishedAt: { not: null } }, select: { id: true, whatnotPublishedAt: true } })
        : null);
    if (!item?.whatnotPublishedAt) continue;
    // Placed before this listing went up through the API: not ours.
    if (new Date(order.created_at).getTime() < item.whatnotPublishedAt.getTime() - 60_000) continue;
    const revenue = amount(line.unit_price) * line.quantity;
    try {
      const r = await recordWhatnotSale({
        itemId: item.id,
        orderId: order.id,
        orderItemId: line.id,
        quantity: line.quantity,
        revenue,
        orderShare: orderTotal > 0 ? revenue / orderTotal : 1 / lines.length,
        soldAt: new Date(order.created_at),
        cancelled: Boolean(order.cancelled_at),
      });
      errors.push(...r.errors);
      if (r.changed) {
        changed.add(item.id);
        // Whatnot puts a cancelled order's units back on its own count
        // (recordWhatnotSale takes a sale's off in the same transaction),
        // so the stock sync below only sends what changed elsewhere.
        if (order.cancelled_at) {
          await prisma.item.updateMany({
            where: { id: item.id, whatnotQuantity: { not: null } },
            data: { whatnotQuantity: { increment: line.quantity } },
          });
        }
      }
    } catch (e) {
      errors.push(`Whatnot order ${order.id}: ${errorText(e)}`);
    }
  }
  // Shopify's count, then Whatnot's own (Shopify's sync only covers items
  // on Shopify; a second pass is a no-op for the rest).
  if (changed.size > 0) {
    const shopify = await runShopifySync({ items: [...changed] });
    errors.push(...shopify.errors);
    errors.push(...(await syncWhatnotStock([...changed])));
  }
  return { changed: [...changed], errors };
}

// The safety net under the order webhook: every order placed or changed
// since the last check (an hour of overlap).
async function pollOrders(deadline: number, errors: string[]): Promise<void> {
  const startedAt = new Date();
  const row = await prisma.appSetting.findUnique({ where: { key: ORDERS_CHECKED_KEY } });
  const since = row ? new Date(new Date(row.value).getTime() - 60 * 60 * 1000) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  let cursor: string | undefined;
  let done = false;
  while (!done && Date.now() < deadline) {
    const page = await listOrders(cursor);
    for (const order of page.items) {
      if (new Date(order.updated_at) < since && new Date(order.created_at) < since) {
        done = true;
        break;
      }
      const r = await processWhatnotOrder(order.id).catch((e) => ({ changed: [], errors: [errorText(e)] }));
      errors.push(...r.errors);
    }
    if (!page.next) break;
    cursor = page.next;
  }
  if (done || Date.now() < deadline) {
    const value = startedAt.toISOString();
    await prisma.appSetting.upsert({ where: { key: ORDERS_CHECKED_KEY }, create: { key: ORDERS_CHECKED_KEY, value }, update: { value } });
  }
}

// Every Whatnot-only auction in the show its bin is assigned to (none if
// its bin has no show). Runs after a bin is assigned and on every cron run
// (items move between bins).
export async function applyBinShows(itemIds?: string[]): Promise<string[]> {
  if (!whatnotConfigured()) return [];
  const errors: string[] = [];
  const items = await prisma.item.findMany({
    where: {
      whatnotOnly: true,
      whatnotProductId: { not: null },
      whatnotPublishedAt: { not: null },
      whatnotEndedAt: null,
      ...(itemIds ? { id: { in: itemIds } } : {}),
    },
    select: { id: true, sku: true, finalTitle: true, whatnotProductId: true, whatnotShowId: true },
  });
  for (const item of items) {
    const want = (await showForItem(item.id))?.showId ?? null;
    if (want === item.whatnotShowId) continue;
    try {
      await merchandise(item.whatnotProductId!, { shows: { strategy: "REPLACE", showIds: want ? [want] : [] } });
      await prisma.item.update({ where: { id: item.id }, data: { whatnotShowId: want } });
    } catch (e) {
      errors.push(`Putting ${item.finalTitle ?? item.sku} in its show: ${errorText(e)}`);
    }
  }
  return errors;
}

export type WhatnotSyncResult = { skipped?: string; listed: number; errors: string[] };

// The 10-minute cron's Whatnot step.
export async function runWhatnotSync(budgetMs = 120_000): Promise<WhatnotSyncResult> {
  if (!whatnotConfigured()) return { skipped: "Whatnot isn't connected.", listed: 0, errors: [] };
  const deadline = Date.now() + budgetMs;
  const errors: string[] = [];
  let listed = 0;
  const run = await withSyncLock("whatnot", "quick", async () => {
    // Webhook deliveries are retried for a few days at most.
    await prisma.whatnotWebhookEvent.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } });
    await pollOrders(deadline, errors).catch((e) => errors.push(`Whatnot orders: ${errorText(e)}`));
    errors.push(...(await applyBinShows()));
    errors.push(...(await syncWhatnotStock("all")));
    listed = await crossListWaiting(20, deadline, errors);
  });
  if (!run.ran) return { skipped: "Another Whatnot sync is running.", listed: 0, errors: [] };
  return { listed, errors };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
