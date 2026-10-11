import { EbayApiError, endFixedPriceItem, withdrawOffer } from "./ebay";
import { parseBundleComponentUnits } from "./itemUnits";
import { prisma } from "./prisma";
import { getShopifyConfig } from "./shopify";
import type { Item } from "@/generated/prisma/client";

// Note on the damaged entries this sweep writes itself — the scan-speed
// report filters on it so an automatic write never counts as someone's scan.
export const AUTO_EXPIRED_NOTE = "Auto-expired — removed from eBay by the daily expiration sweep";

export type ExpireListingsResult = {
  scanned: number;
  expired: number;
  // Moved to the Shopify past-date page instead of pulled.
  pastDated: number;
  // Past-date items pulled at PAST_DATE_SELL_MONTHS past their date.
  pulledPastDate: number;
  // Everything this run moved or pulled, for the Shopify sync to follow.
  changedItemIds: string[];
  failed: number;
  errors: string[];
};

// eBay's own food policy doesn't set a "pull the listing by X" deadline —
// it requires the item to be *delivered* to the buyer before the printed
// expiration date. Ending a listing ON its expiration date is not
// compliant: a sale made hours before removal still needs days to process
// and ship, landing well after the date has passed. This buffer is how
// many days BEFORE the printed expirationDate the listing actually comes
// down, sized to cover that gap. Configurable (Settings) rather than
// hardcoded, same reasoning as the other business-judgment percentages
// elsewhere in this app (target margins, etc.) — Cristian's own stated
// worst case ("sometimes it takes 7 days to process the order") plus
// shipping transit is what the default is based on.
const EXPIRATION_BUFFER_DAYS_KEY = "expiration_removal_buffer_days";
const DEFAULT_EXPIRATION_BUFFER_DAYS = 7;

export async function getExpirationBufferDays(): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key: EXPIRATION_BUFFER_DAYS_KEY } });
  const value = row ? Number(row.value) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_EXPIRATION_BUFFER_DAYS;
}

export async function setExpirationBufferDays(days: number): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: EXPIRATION_BUFFER_DAYS_KEY },
    create: { key: EXPIRATION_BUFFER_DAYS_KEY, value: String(days) },
    update: { value: String(days) },
  });
}

// "Today" in America/Chicago, as a YYYY-MM-DD string — expirationDate is
// stored as a plain date (midnight UTC, from a date-only <input>), so
// comparing calendar dates this way sidesteps converting between an actual
// Chicago wall-clock instant and UTC (which would need real DST handling);
// it only needs to know WHICH calendar day it currently is in Chicago.
function chicagoTodayDateString(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}

// Ends every live eBay listing whose expirationDate is within the
// configured buffer window (today + bufferDays, in Chicago) — not just
// ones that have already reached their date, per the compliance reasoning
// above. For anything still listed and expired that eBay hasn't confirmed
// removed, leaves it alone for the next run to retry. Called by
// /api/cron/expire-listings, gated there to roughly once a day around 8PM
// Chicago; safe to call more than once since an already-"expired" item
// won't match the eligibility query again.
export async function expireDueListings(now: Date = new Date()): Promise<ExpireListingsResult> {
  const result: ExpireListingsResult = {
    scanned: 0,
    expired: 0,
    pastDated: 0,
    pulledPastDate: 0,
    changedItemIds: [],
    failed: 0,
    errors: [],
  };

  const bufferDays = await getExpirationBufferDays();
  const chicagoToday = chicagoTodayDateString(now);
  const cutoff = new Date(new Date(`${chicagoToday}T23:59:59.999Z`).getTime() + bufferDays * 24 * 60 * 60 * 1000);

  const items = await prisma.item.findMany({
    where: {
      status: { in: ["listed", "exported"] },
      OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }, { shopifyOnly: true }],
      expirationDate: { not: null, lte: cutoff },
      // Already in the past-date lane: handled by the second pass below.
      pastDateAt: null,
    },
  });
  result.scanned = items.length;
  const paths = await categoryPaths(items.map((i) => i.categoryId));

  for (const item of items) {
    try {
      if (item.ebayOfferId) {
        await withdrawOffer(item.ebayOfferId);
      } else if (item.ebayListingId) {
        await endFixedPriceItem(item.ebayListingId);
      }

      if (canGoPastDate(item, paths.get(item.categoryId ?? "") ?? "")) {
        // Off eBay (just now) and Whatnot (the Shopify sync), still for
        // sale on the Shopify store at 65% off with the date disclosed. Not
        // pulled: nothing for staff to do yet.
        await prisma.item.update({
          where: { id: item.id },
          data: { pastDateAt: now, listingEndedAt: item.ebayOfferId || item.ebayListingId ? now : null, ebayEndError: null },
        });
        result.pastDated++;
        result.changedItemIds.push(item.id);
        continue;
      }

      await retire(item, now);
      result.expired++;
      result.changedItemIds.push(item.id);
    } catch (e) {
      const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Failed to end listing.";
      result.failed++;
      result.errors.push(`Item ${item.id} (${item.sku}): ${message}`);
      try {
        await prisma.item.update({ where: { id: item.id }, data: { ebayEndError: message } });
      } catch (updateError) {
        result.errors.push(
          `Item ${item.id}: failed to record ebayEndError: ${updateError instanceof Error ? updateError.message : String(updateError)}`
        );
      }
    }
  }

  // Past-date items that are now PAST_DATE_SELL_MONTHS past their date:
  // pulled for real. Status "expired" takes them off Shopify on the next
  // sync and puts them on the dashboard's shelf-pull list.
  const todayStart = new Date(`${chicagoToday}T00:00:00.000Z`);
  const pastDate = await prisma.item.findMany({
    where: { pastDateAt: { not: null }, status: { in: ["listed", "exported"] }, expirationDate: { not: null } },
  });
  for (const item of pastDate) {
    const pullOn = new Date(item.expirationDate!);
    pullOn.setUTCMonth(pullOn.getUTCMonth() + PAST_DATE_SELL_MONTHS);
    if (pullOn > todayStart) continue;
    try {
      await retire(item, now);
      result.pulledPastDate++;
      result.changedItemIds.push(item.id);
    } catch (e) {
      result.failed++;
      result.errors.push(`Item ${item.id} (${item.sku}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

// Pulled for good: status "expired", and whatever's left counted as
// expired on its manifest.
async function retire(item: Item, now: Date): Promise<void> {
  const remainingByUpc = new Map<string, number>();
  const remainingUnits = Math.max(0, item.quantity - item.soldQuantity);
  if (item.isBundle) {
    for (const c of parseBundleComponentUnits(item.bundleComponents)) {
      remainingByUpc.set(c.upc, (remainingByUpc.get(c.upc) ?? 0) + c.unitsPerBundle * remainingUnits);
    }
  } else if (item.upc) {
    const packSize = item.isMultipack && item.packSize ? item.packSize : 1;
    remainingByUpc.set(item.upc, remainingUnits * packSize);
  }

  await prisma.$transaction([
    prisma.item.update({
      where: { id: item.id },
      data: { status: "expired", expiredAt: now, ebayEndError: null },
    }),
    // If this came from a manifest, its remaining stock needs to stop
    // looking "missing" on that manifest's reconciliation — reuses the
    // exact same bucket the Scan page's own "Damaged/Expired" mode
    // already writes to (the two are already the same concept in this
    // app's own UI wording), rather than inventing a separate one.
    ...(item.manifestId
      ? [...remainingByUpc.entries()]
          .filter(([, units]) => units > 0)
          .map(([upc, units]) =>
            prisma.manifestDamagedEntry.create({
              data: {
                manifestId: item.manifestId!,
                upc,
                quantity: units,
                note: AUTO_EXPIRED_NOTE,
                recordedBy: null,
              },
            })
          )
      : []),
  ]);
}

// Cristian: past-date items can still sell on the Shopify store, disclosed,
// for up to this long past the date.
export const PAST_DATE_SELL_MONTHS = 6;

// Never sold past date, even disclosed: drugs (over-the-counter medicine,
// and sunscreen, which the FDA regulates as one) and infant formula / baby
// food (federal use-by rules). Matched against the eBay category path.
const PAST_DATE_EXCLUDED = /Over-the-Counter Medications|Sunscreen|Baby Formula|Baby Food/i;

function canGoPastDate(item: Item, categoryPath: string): boolean {
  return (
    Boolean(getShopifyConfig()) &&
    item.shopifyPublishedAt != null &&
    item.shopifyArchivedAt == null &&
    !item.localPickupOnly &&
    item.quantity - item.soldQuantity > 0 &&
    !PAST_DATE_EXCLUDED.test(categoryPath)
  );
}

async function categoryPaths(categoryIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(categoryIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.ebayCategory.findMany({ where: { id: { in: ids } }, select: { id: true, path: true } });
  return new Map(rows.map((r) => [r.id, r.path]));
}
