import { v2 as cloudinary } from "cloudinary";
import type { EbayListingBackup, Item, Prisma } from "@/generated/prisma/client";
import {
  createOffer,
  createOrReplaceInventoryItem,
  getAllActiveListings,
  getConnectedSellerId,
  getEbayEnvironment,
  getFullListingXml,
  publishOffer,
  refreshOffer,
  toEbaySku,
  toItemForEbayPublish,
  type ActiveListing,
} from "./ebay";
import { prisma } from "./prisma";
import { queueShopifyPublish } from "./shopifySync";

// Keeps a copy of every live eBay listing on our side (EbayListingBackup),
// so if the eBay account is ever shut down, a new one can be connected and
// everything put back up from here, no re-scanning or re-photographing.
// Cristian, 2026-10-23.
//
// Backup (runListingBackup, hourly cron): the active list gives price and
// quantity for every listing each run; the full listing (description,
// photos, specifics, weight) is pulled with GetItem for new listings, ones
// whose title changed, and every few days for the rest. Photos of listings
// made straight on eBay are copied to Cloudinary, since eBay's copies go
// with the account. The app's own listings already have theirs there.
//
// Restore (restoreListings): with a different eBay account connected,
// re-lists every listing that was live on the old one. An app listing keeps
// its Item (sales history, bins, Shopify product); only its eBay IDs change,
// and only once the new listing is actually live, so the Shopify sync never
// sees it "off eBay" and archives it. A listing made on eBay becomes a new
// Item built from the backup.

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const PHOTO_FOLDER = "ebay-listing-backup";
const REFRESH_DETAILS_MS = 5 * 24 * 60 * 60 * 1000;
const LAST_RUN_KEY = "listingBackup.lastRun";

export type BackupRunResult = {
  at: string;
  ok: boolean;
  error?: string;
  sellerUserId?: string | null;
  live?: number;
  added?: number;
  ended?: number;
  detailsFetched?: number;
  detailsLeft?: number;
  photosSaved?: number;
  failures?: number;
  // Set when the active list came back far shorter than what's backed up
  // as live, so nothing was marked ended (see the guard below).
  warning?: string;
};

// ---------------------------------------------------------------------------
// GetItem parsing
// ---------------------------------------------------------------------------

function decode(value: string): string {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function field(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?: [^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]) : null;
}

function allFields(block: string, tag: string): string[] {
  return [...block.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => decode(m[1]));
}

function numberOrNull(value: string | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// A buyer's details (the last buyer's eBay ID and ZIP come back under
// HighBidder) have no business in a listing backup; the seller's email
// either.
function stripPersonalData(xml: string): string {
  return xml.replace(/<HighBidder>[\s\S]*?<\/HighBidder>/g, "").replace(/<Email>[\s\S]*?<\/Email>/g, "");
}

type ParsedListing = {
  sellerUserId: string | null;
  sku: string | null;
  title: string;
  description: string | null;
  price: number;
  quantityAvailable: number;
  quantitySold: number;
  categoryId: string | null;
  categoryName: string | null;
  conditionId: string | null;
  conditionName: string | null;
  itemSpecifics: Record<string, string[]>;
  upc: string | null;
  weightLbs: number | null;
  weightOz: number | null;
  packageLength: number | null;
  packageWidth: number | null;
  packageDepth: number | null;
  bestOfferEnabled: boolean;
  ebayPhotoUrls: string[];
  listingStartedAt: Date | null;
  active: boolean;
};

export function parseListingXml(xml: string): ParsedListing {
  const item = xml.match(/<Item>([\s\S]*)<\/Item>/)?.[1] ?? "";
  const seller = item.match(/<Seller>([\s\S]*?)<\/Seller>/)?.[1] ?? "";
  const selling = item.match(/<SellingStatus>([\s\S]*?)<\/SellingStatus>/)?.[1] ?? "";
  const category = item.match(/<PrimaryCategory>([\s\S]*?)<\/PrimaryCategory>/)?.[1] ?? "";
  const pkg = item.match(/<ShippingPackageDetails>([\s\S]*?)<\/ShippingPackageDetails>/)?.[1] ?? "";
  const pictures = item.match(/<PictureDetails>([\s\S]*?)<\/PictureDetails>/)?.[1] ?? "";
  const specificsBlock = item.match(/<ItemSpecifics>([\s\S]*?)<\/ItemSpecifics>/)?.[1] ?? "";
  const productDetails = item.match(/<ProductListingDetails>([\s\S]*?)<\/ProductListingDetails>/)?.[1] ?? "";

  const itemSpecifics: Record<string, string[]> = {};
  for (const nv of specificsBlock.match(/<NameValueList>[\s\S]*?<\/NameValueList>/g) ?? []) {
    const name = field(nv, "Name");
    const values = allFields(nv, "Value").filter(Boolean);
    if (name && values.length > 0) itemSpecifics[name] = values;
  }
  const specificUpc = Object.entries(itemSpecifics).find(([k]) => k.toLowerCase() === "upc")?.[1][0];
  const upc = [field(productDetails, "UPC"), specificUpc].find((v) => v && /^\d{8,14}$/.test(v)) ?? null;

  const quantity = numberOrNull(field(item, "Quantity")) ?? 0;
  const quantitySold = numberOrNull(field(selling, "QuantitySold")) ?? 0;
  const startTime = field(item.match(/<ListingDetails>([\s\S]*?)<\/ListingDetails>/)?.[1] ?? "", "StartTime");

  return {
    sellerUserId: field(seller, "UserID"),
    sku: field(item, "SKU"),
    title: field(item, "Title") ?? "",
    description: field(item, "Description"),
    price: numberOrNull(field(selling, "CurrentPrice")) ?? numberOrNull(field(item, "StartPrice")) ?? 0,
    quantityAvailable: Math.max(0, quantity - quantitySold),
    quantitySold,
    categoryId: field(category, "CategoryID"),
    categoryName: field(category, "CategoryName"),
    conditionId: field(item, "ConditionID"),
    conditionName: field(item, "ConditionDisplayName"),
    itemSpecifics,
    upc,
    weightLbs: numberOrNull(field(pkg, "WeightMajor")),
    weightOz: numberOrNull(field(pkg, "WeightMinor")),
    packageLength: numberOrNull(field(pkg, "PackageLength")),
    packageWidth: numberOrNull(field(pkg, "PackageWidth")),
    packageDepth: numberOrNull(field(pkg, "PackageDepth")),
    bestOfferEnabled: field(item, "BestOfferEnabled") === "true",
    // A listing made from eBay's catalog with no photos of its own shows the
    // catalog's stock photo instead.
    ebayPhotoUrls: allFields(pictures, "PictureURL").length
      ? allFields(pictures, "PictureURL")
      : allFields(productDetails, "StockPhotoURL"),
    listingStartedAt: startTime ? new Date(startTime) : null,
    active: field(selling, "ListingStatus") === "Active",
  };
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

// GetItem hands back a mid-size picture ("…/z/{id}/$_57.JPG"); the same
// picture at full size is /images/g/{id}/s-l1600.jpg. Catalog stock photos
// come as /images/g/{id}/s-l640.jpg.
function fullSizePhotoUrl(url: string): string | null {
  const id = url.match(/\/z\/([^/]+)\/\$_\d+\.\w+/)?.[1] ?? url.match(/\/images\/g\/([^/]+)\/s-l\d+\.\w+/)?.[1];
  return id ? `https://i.ebayimg.com/images/g/${id}/s-l1600.jpg` : null;
}

async function copyPhoto(listingId: string, index: number, url: string): Promise<string> {
  const options = { folder: PHOTO_FOLDER, public_id: `${listingId}-${index + 1}`, overwrite: true, resource_type: "image" as const };
  const big = fullSizePhotoUrl(url);
  if (big) {
    try {
      return (await cloudinary.uploader.upload(big, options)).secure_url;
    } catch {
      // Fall back to the URL exactly as eBay gave it.
    }
  }
  return (await cloudinary.uploader.upload(url, options)).secure_url;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

async function saveLastRun(result: BackupRunResult): Promise<void> {
  const value = JSON.stringify(result);
  await prisma.appSetting.upsert({ where: { key: LAST_RUN_KEY }, create: { key: LAST_RUN_KEY, value }, update: { value } });
}

export async function getLastBackupRun(): Promise<BackupRunResult | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: LAST_RUN_KEY } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as BackupRunResult;
  } catch {
    return null;
  }
}

// Pulls one listing in full and saves it. Photos are copied when the app
// didn't make the listing and eBay's photo list changed since last time.
async function backupDetails(row: EbayListingBackup): Promise<{ photosSaved: number }> {
  const xml = await getFullListingXml(row.listingId);
  const p = parseListingXml(xml);
  let photosSaved = 0;
  let savedPhotoUrls = row.savedPhotoUrls;
  let photoError: string | null = row.photoError;
  const photosChanged =
    p.ebayPhotoUrls.length !== row.ebayPhotoUrls.length || p.ebayPhotoUrls.some((u, i) => u !== row.ebayPhotoUrls[i]);
  const needsPhotos = !row.itemId && (photosChanged || savedPhotoUrls.length !== p.ebayPhotoUrls.length || photoError);
  if (needsPhotos) {
    try {
      savedPhotoUrls = [];
      for (const [i, url] of p.ebayPhotoUrls.entries()) {
        savedPhotoUrls.push(await copyPhoto(row.listingId, i, url));
        photosSaved++;
      }
      photoError = null;
    } catch (e) {
      photoError = e instanceof Error ? e.message : String(e);
      savedPhotoUrls = row.savedPhotoUrls;
    }
  }
  await prisma.ebayListingBackup.update({
    where: { listingId: row.listingId },
    data: {
      sellerUserId: p.sellerUserId ?? row.sellerUserId,
      sku: p.sku,
      title: p.title || row.title,
      description: p.description,
      price: p.price,
      quantityAvailable: p.quantityAvailable,
      quantitySold: p.quantitySold,
      categoryId: p.categoryId,
      categoryName: p.categoryName,
      conditionId: p.conditionId,
      conditionName: p.conditionName,
      itemSpecifics: p.itemSpecifics as Prisma.InputJsonValue,
      upc: p.upc,
      weightLbs: p.weightLbs,
      weightOz: p.weightOz,
      packageLength: p.packageLength,
      packageWidth: p.packageWidth,
      packageDepth: p.packageDepth,
      bestOfferEnabled: p.bestOfferEnabled,
      ebayPhotoUrls: p.ebayPhotoUrls,
      savedPhotoUrls,
      photoError,
      listingStartedAt: p.listingStartedAt,
      rawXml: stripPersonalData(xml),
      detailsFetchedAt: new Date(),
      detailsError: null,
    },
  });
  return { photosSaved };
}

// One pass. budgetMs bounds the GetItem/photo work so it fits a cron run;
// whatever's left is picked up next hour (new listings first).
export async function runListingBackup(options: { budgetMs: number; acceptDrop?: boolean }): Promise<BackupRunResult> {
  const started = Date.now();
  const result: BackupRunResult = { at: new Date().toISOString(), ok: false };
  try {
    const sellerUserId = await getConnectedSellerId();
    const live: ActiveListing[] = await getAllActiveListings();
    result.sellerUserId = sellerUserId;
    result.live = live.length;
    const liveIds = live.map((l) => l.itemId);

    const existing = await prisma.ebayListingBackup.findMany({
      where: { listingId: { in: liveIds } },
      select: { listingId: true, title: true, price: true, quantityAvailable: true, quantitySold: true, itemId: true, endedAt: true },
    });
    const byId = new Map(existing.map((r) => [r.listingId, r]));
    const appItems = await prisma.item.findMany({
      where: { ebayListingId: { in: liveIds } },
      select: { id: true, ebayListingId: true },
    });
    const itemByListing = new Map(appItems.map((i) => [i.ebayListingId!, i.id]));

    const now = new Date();
    const fresh = live.filter((l) => !byId.has(l.itemId));
    if (fresh.length > 0) {
      await prisma.ebayListingBackup.createMany({
        data: fresh.map((l) => ({
          listingId: l.itemId,
          sellerUserId,
          itemId: itemByListing.get(l.itemId) ?? null,
          sku: l.sku || null,
          title: decode(l.title),
          price: l.price,
          quantityAvailable: l.available,
          quantitySold: l.sold,
          lastSeenActiveAt: now,
        })),
        skipDuplicates: true,
      });
    }
    result.added = fresh.length;

    // Price/quantity/title from the active list; a new title means the
    // listing was edited, so its details get pulled again.
    for (const l of live) {
      const row = byId.get(l.itemId);
      if (!row) continue;
      const title = decode(l.title);
      const itemId = itemByListing.get(l.itemId) ?? row.itemId;
      const changed =
        row.title !== title ||
        Number(row.price) !== l.price ||
        row.quantityAvailable !== l.available ||
        row.quantitySold !== l.sold ||
        row.itemId !== itemId ||
        row.endedAt != null;
      if (!changed) continue;
      await prisma.ebayListingBackup.update({
        where: { listingId: l.itemId },
        data: {
          title,
          price: l.price,
          quantityAvailable: l.available,
          quantitySold: l.sold,
          itemId,
          endedAt: null,
          ...(row.title !== title ? { detailsFetchedAt: null } : {}),
        },
      });
    }
    await prisma.ebayListingBackup.updateMany({ where: { listingId: { in: liveIds } }, data: { lastSeenActiveAt: now } });

    // Listings of this account no longer on its active list have ended.
    // Other accounts' rows are left exactly as they were: after a switch,
    // they're what gets restored. And if this account's list suddenly comes
    // back far shorter than what's backed up (an account in trouble can
    // answer with an empty list), nothing is ended, so the last good copy
    // of each listing survives.
    // acceptDrop is the page's "yes, those really ended" button.
    const wasLive =
      (await prisma.ebayListingBackup.count({
        where: { endedAt: null, OR: [{ sellerUserId }, { sellerUserId: null }] },
      })) - fresh.length;
    if (!options.acceptDrop && wasLive >= 20 && live.length < wasLive * 0.5) {
      result.warning = `eBay's active list has ${live.length} listings but ${wasLive} were live in the backup. Nothing was marked ended, in case the account is in trouble. If you ended them yourself, confirm it on the backup page.`;
      result.ended = 0;
    } else {
      const ended = await prisma.ebayListingBackup.updateMany({
        where: {
          endedAt: null,
          listingId: { notIn: liveIds },
          OR: [{ sellerUserId }, { sellerUserId: null }],
        },
        data: { endedAt: now },
      });
      result.ended = ended.count;
    }

    // Full details: never-pulled first, then the stalest.
    const staleBefore = new Date(Date.now() - REFRESH_DETAILS_MS);
    const queue = await prisma.ebayListingBackup.findMany({
      where: {
        listingId: { in: liveIds },
        OR: [{ detailsFetchedAt: null }, { detailsFetchedAt: { lt: staleBefore } }, { photoError: { not: null } }],
      },
      orderBy: [{ detailsFetchedAt: { sort: "asc", nulls: "first" } }],
    });
    let detailsFetched = 0;
    let photosSaved = 0;
    let failures = 0;
    for (const row of queue) {
      if (Date.now() - started > options.budgetMs) break;
      try {
        const r = await backupDetails(row);
        photosSaved += r.photosSaved;
        detailsFetched++;
      } catch (e) {
        failures++;
        await prisma.ebayListingBackup.update({
          where: { listingId: row.listingId },
          data: { detailsError: (e instanceof Error ? e.message : String(e)).slice(0, 500) },
        });
      }
    }
    result.detailsFetched = detailsFetched;
    result.detailsLeft = queue.length - detailsFetched - failures;
    result.photosSaved = photosSaved;
    result.failures = failures;
    result.ok = true;
  } catch (e) {
    // eBay unreachable or the account's token refused: nothing in the
    // backup is touched, so the last good copy stays.
    result.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }
  await saveLastRun(result);
  return result;
}

// ---------------------------------------------------------------------------
// Summary + export
// ---------------------------------------------------------------------------

export type BackupAccountSummary = {
  sellerUserId: string | null;
  live: number;
  units: number;
  value: number;
  madeInApp: number;
  madeOnEbay: number;
  complete: number;
  missingDetails: number;
  missingPhotos: number;
  restored: number;
  restoreErrors: number;
};

export type BackupSummary = {
  lastRun: BackupRunResult | null;
  accounts: BackupAccountSummary[];
  ended: number;
};

// "Complete" = enough saved to put it back up: full details, plus photos
// (the Item's for app listings, our Cloudinary copies otherwise).
export async function getBackupSummary(): Promise<BackupSummary> {
  const rows = await prisma.ebayListingBackup.findMany({
    where: { endedAt: null },
    select: {
      sellerUserId: true,
      itemId: true,
      quantityAvailable: true,
      price: true,
      detailsFetchedAt: true,
      savedPhotoUrls: true,
      ebayPhotoUrls: true,
      restoredAt: true,
      restoreError: true,
    },
  });
  const accounts = new Map<string | null, BackupAccountSummary>();
  for (const r of rows) {
    let a = accounts.get(r.sellerUserId);
    if (!a) {
      a = {
        sellerUserId: r.sellerUserId,
        live: 0,
        units: 0,
        value: 0,
        madeInApp: 0,
        madeOnEbay: 0,
        complete: 0,
        missingDetails: 0,
        missingPhotos: 0,
        restored: 0,
        restoreErrors: 0,
      };
      accounts.set(r.sellerUserId, a);
    }
    a.live++;
    a.units += r.quantityAvailable;
    a.value += r.quantityAvailable * Number(r.price);
    if (r.itemId) a.madeInApp++;
    else a.madeOnEbay++;
    const hasDetails = Boolean(r.detailsFetchedAt);
    const hasPhotos = Boolean(r.itemId) || (r.savedPhotoUrls.length > 0 && r.savedPhotoUrls.length >= r.ebayPhotoUrls.length);
    if (!hasDetails) a.missingDetails++;
    else if (!hasPhotos) a.missingPhotos++;
    else a.complete++;
    if (r.restoredAt) a.restored++;
    else if (r.restoreError) a.restoreErrors++;
  }
  const ended = await prisma.ebayListingBackup.count({ where: { endedAt: { not: null } } });
  return {
    lastRun: await getLastBackupRun(),
    accounts: [...accounts.values()].sort((a, b) => b.live - a.live),
    ended,
  };
}

// Everything that's live, as plain data, for a download Cristian can keep
// off the app entirely. App listings get their Item's photos.
export async function exportBackup(): Promise<Record<string, unknown>[]> {
  const rows = await prisma.ebayListingBackup.findMany({ where: { endedAt: null }, orderBy: { firstSeenAt: "asc" } });
  const items = await prisma.item.findMany({
    where: { id: { in: rows.map((r) => r.itemId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, photoUrls: true, shelfLocation: true, sku: true },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));
  return rows.map((r) => {
    const item = r.itemId ? itemById.get(r.itemId) : undefined;
    return {
      listingId: r.listingId,
      account: r.sellerUserId,
      madeInApp: Boolean(r.itemId),
      sku: item?.sku ?? r.sku,
      shelfLocation: item?.shelfLocation ?? null,
      title: r.title,
      price: Number(r.price),
      quantityAvailable: r.quantityAvailable,
      quantitySold: r.quantitySold,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      condition: r.conditionName,
      conditionId: r.conditionId,
      upc: r.upc,
      weightLbs: r.weightLbs,
      weightOz: r.weightOz,
      packageInches: r.packageLength ? [r.packageLength, r.packageWidth, r.packageDepth] : null,
      bestOfferEnabled: r.bestOfferEnabled,
      itemSpecifics: r.itemSpecifics,
      photos: item?.photoUrls.length ? item.photoUrls : r.savedPhotoUrls,
      description: r.description,
      listingStartedAt: r.listingStartedAt,
      backedUpAt: r.detailsFetchedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Restore onto a new account
// ---------------------------------------------------------------------------

const CONDITION_BY_ID: Record<string, Item["condition"]> = {
  "1000": "new",
  "1500": "new_other",
  "1750": "new_other",
  "7000": "for_parts",
};

function conditionFromId(id: string | null): NonNullable<Item["condition"]> {
  if (!id) return "new";
  return CONDITION_BY_ID[id] ?? "used";
}

// The app keeps one value per specific; eBay's are lists. The first value
// is one eBay already accepted for this category. UPC goes on the product
// itself, not as a specific.
function flattenSpecifics(specifics: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, values] of Object.entries((specifics as Record<string, string[]> | null) ?? {})) {
    if (name.toLowerCase() === "upc") continue;
    if (Array.isArray(values) && values[0]) out[name] = values[0];
  }
  return out;
}

// "Location - B4" in an old listing's custom label, as the app's skus write it.
function locationFromSku(sku: string | null): string | null {
  return sku?.match(/Location\s*-?\s*([A-Za-z0-9]+)/i)?.[1] ?? null;
}

export type RestorePreflight = {
  connectedSellerId: string | null;
  // Accounts with listings waiting to go onto the connected one.
  fromAccounts: { sellerUserId: string | null; waiting: number; restored: number; failed: number }[];
  error?: string;
};

// Rows that were live on some other account and haven't been put up on the
// connected one yet.
function waitingWhere(connectedSellerId: string): Prisma.EbayListingBackupWhereInput {
  return {
    endedAt: null,
    restoredAt: null,
    quantityAvailable: { gt: 0 },
    sellerUserId: { not: connectedSellerId },
  };
}

export async function getRestorePreflight(): Promise<RestorePreflight> {
  let connectedSellerId: string | null = null;
  try {
    connectedSellerId = await getConnectedSellerId();
  } catch (e) {
    return { connectedSellerId: null, fromAccounts: [], error: e instanceof Error ? e.message : String(e) };
  }
  if (!connectedSellerId) return { connectedSellerId, fromAccounts: [], error: "eBay didn't say which account is connected." };
  const rows = await prisma.ebayListingBackup.groupBy({
    by: ["sellerUserId"],
    where: { endedAt: null, sellerUserId: { not: connectedSellerId } },
    _count: { _all: true },
  });
  const fromAccounts: RestorePreflight["fromAccounts"] = [];
  for (const r of rows) {
    const base = { endedAt: null, sellerUserId: r.sellerUserId };
    const [waiting, restored, failed] = await Promise.all([
      prisma.ebayListingBackup.count({ where: { ...base, restoredAt: null, quantityAvailable: { gt: 0 } } }),
      prisma.ebayListingBackup.count({ where: { ...base, restoredAt: { not: null } } }),
      prisma.ebayListingBackup.count({ where: { ...base, restoredAt: null, restoreError: { not: null } } }),
    ]);
    fromAccounts.push({ sellerUserId: r.sellerUserId, waiting, restored, failed });
  }
  return { connectedSellerId, fromAccounts };
}

// An Item to publish from a listing the app didn't make. Status "ready" (not
// "listed") until it's live, so neither the Shopify sync nor anything else
// treats it as for sale yet.
async function itemFromBackup(row: EbayListingBackup): Promise<Item> {
  if (row.savedPhotoUrls.length === 0) throw new Error("No saved photos for this listing.");
  const location = locationFromSku(row.sku);
  return prisma.item.create({
    data: {
      ...(location ? { sku: `(Location - ${location})-${crypto.randomUUID()}` } : {}),
      status: "ready",
      upc: row.upc,
      quantity: row.quantityAvailable,
      shelfLocation: location ?? "Unknown",
      photoUrls: row.savedPhotoUrls,
      finalTitle: row.title,
      finalDescription: row.description ?? row.title,
      price: row.price,
      categoryId: row.categoryId,
      condition: conditionFromId(row.conditionId),
      itemSpecifics: flattenSpecifics(row.itemSpecifics),
      weightLbs: row.weightLbs,
      weightOz: row.weightOz,
      reviewedBy: "restore",
      reviewedAt: new Date(),
    },
  });
}

// Puts one backed-up listing up on the connected account. Returns the new
// listing ID.
async function restoreOne(row: EbayListingBackup): Promise<string> {
  let item = row.itemId ? await prisma.item.findUnique({ where: { id: row.itemId } }) : null;
  if (item && item.quantity - item.soldQuantity <= 0) throw new Error("Sold out in the app; nothing to list.");
  if (item && (item.expiredAt || item.pastDateAt || item.listingEndedAt || item.shopifyOnly)) {
    throw new Error("Not for sale on eBay in the app anymore (ended, expired, past-date or Shopify only).");
  }
  if (!item) {
    item = await itemFromBackup(row);
    await prisma.ebayListingBackup.update({ where: { listingId: row.listingId }, data: { itemId: item.id } });
  }

  // Blanks the Item has get filled from what eBay last showed.
  const publishData = toItemForEbayPublish({
    ...item,
    finalTitle: item.finalTitle ?? row.title,
    finalDescription: item.finalDescription ?? row.description ?? row.title,
    price: item.price ?? row.price,
    categoryId: item.categoryId ?? row.categoryId,
    condition: item.condition ?? conditionFromId(row.conditionId),
    weightLbs: item.weightLbs ?? (item.weightOz == null ? row.weightLbs : null),
    weightOz: item.weightOz ?? (item.weightLbs == null ? row.weightOz : null),
    upc: item.upc ?? row.upc,
  });
  const missing: string[] = [];
  if (!publishData.finalTitle) missing.push("title");
  if (!publishData.categoryId) missing.push("category");
  if (publishData.photoUrls.length === 0) missing.push("photos");
  if (!publishData.localPickupOnly && !publishData.weightLbs && !publishData.weightOz) missing.push("weight");
  if (missing.length > 0) throw new Error(`Missing ${missing.join(", ")}. Fix it in Review, then publish it there.`);

  await createOrReplaceInventoryItem(publishData);
  let offerId = row.restoreOfferId;
  if (offerId) {
    await refreshOffer(offerId, publishData);
  } else {
    offerId = await createOffer(publishData);
    await prisma.ebayListingBackup.update({ where: { listingId: row.listingId }, data: { restoreOfferId: offerId } });
  }
  const listingId = await publishOffer(offerId);

  // Only now, with the new listing live, does the Item point at it. The
  // old account's ad and markdown are gone with it.
  await prisma.item.update({
    where: { id: item.id },
    data: {
      status: "listed",
      ebayOfferId: offerId,
      ebayListingId: listingId,
      ebaySku: toEbaySku(item.sku),
      ebayPublishedAt: new Date(),
      ebayPublishError: null,
      ebayEnvironment: getEbayEnvironment(),
      ebayEndError: null,
      ebayAdId: null,
      ebayAdCampaignId: null,
      promotedBidPercentage: null,
      promotedAt: null,
      ebayPromoteError: null,
      ebayMarkdownId: null,
      markdownPercentOff: null,
      markdownStartedAt: null,
      markdownEndsAt: null,
      ebayMarkdownError: null,
    },
  });
  await prisma.ebayListingBackup.update({
    where: { listingId: row.listingId },
    data: { restoredAt: new Date(), restoredListingId: listingId, restoreError: null },
  });
  // Items made from the backup weren't on Shopify yet; app ones already are
  // (and queueShopifyPublish skips them).
  queueShopifyPublish(item.id);
  return listingId;
}

export type RestoreBatchResult = {
  restored: number;
  failed: { listingId: string; title: string; error: string }[];
  remaining: number;
  connectedSellerId: string;
};

// One batch of the restore, sized to a single request. The page calls it
// again until nothing's left. Refuses outright when the backup's own
// account is the one connected: re-listing there would double everything.
export async function restoreListings(options: { budgetMs: number; retryFailed?: boolean }): Promise<RestoreBatchResult> {
  const started = Date.now();
  const connectedSellerId = await getConnectedSellerId();
  if (!connectedSellerId) throw new Error("eBay didn't say which account is connected.");
  const where = waitingWhere(connectedSellerId);
  const rows = await prisma.ebayListingBackup.findMany({
    where: options.retryFailed ? where : { ...where, restoreError: null },
    orderBy: { firstSeenAt: "asc" },
  });
  const result: RestoreBatchResult = { restored: 0, failed: [], remaining: 0, connectedSellerId };
  for (const row of rows) {
    if (Date.now() - started > options.budgetMs) break;
    try {
      await restoreOne(row);
      result.restored++;
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await prisma.ebayListingBackup.update({ where: { listingId: row.listingId }, data: { restoreError: error } });
      result.failed.push({ listingId: row.listingId, title: row.title, error });
    }
  }
  result.remaining = await prisma.ebayListingBackup.count({ where: { ...where, restoreError: null } });
  return result;
}

export async function getRestoreFailures(): Promise<{ listingId: string; title: string; error: string; itemId: string | null }[]> {
  const rows = await prisma.ebayListingBackup.findMany({
    where: { endedAt: null, restoredAt: null, restoreError: { not: null } },
    select: { listingId: true, title: true, restoreError: true, itemId: true },
    orderBy: { title: "asc" },
  });
  return rows.map((r) => ({ listingId: r.listingId, title: r.title, error: r.restoreError!, itemId: r.itemId }));
}
