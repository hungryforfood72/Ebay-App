import { EbayApiError, endFixedPriceItem, withdrawOffer } from "./ebay";
import { parseBundleComponentUnits } from "./itemUnits";
import { prisma } from "./prisma";

export type ExpireListingsResult = {
  scanned: number;
  expired: number;
  failed: number;
  errors: string[];
};

// "Today" in America/Chicago, as a YYYY-MM-DD string — expirationDate is
// stored as a plain date (midnight UTC, from a date-only <input>), so
// comparing calendar dates this way sidesteps converting between an actual
// Chicago wall-clock instant and UTC (which would need real DST handling);
// it only needs to know WHICH calendar day it currently is in Chicago.
function chicagoTodayDateString(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}

// Ends every live eBay listing whose expirationDate has reached today (or
// earlier) in Chicago, and — for anything still listed and expired that
// eBay hasn't confirmed removed — leaves it alone for the next run to
// retry. Called by /api/cron/expire-listings, gated there to roughly
// once a day around 8PM Chicago; safe to call more than once since an
// already-"expired" item won't match the eligibility query again.
export async function expireDueListings(now: Date = new Date()): Promise<ExpireListingsResult> {
  const result: ExpireListingsResult = { scanned: 0, expired: 0, failed: 0, errors: [] };

  const cutoff = new Date(`${chicagoTodayDateString(now)}T23:59:59.999Z`);

  const items = await prisma.item.findMany({
    where: {
      status: { in: ["listed", "exported"] },
      OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }],
      expirationDate: { not: null, lte: cutoff },
    },
  });
  result.scanned = items.length;

  for (const item of items) {
    try {
      if (item.ebayOfferId) {
        await withdrawOffer(item.ebayOfferId);
      } else if (item.ebayListingId) {
        await endFixedPriceItem(item.ebayListingId);
      }

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
                    note: "Auto-expired — removed from eBay by the daily expiration sweep",
                    recordedBy: null,
                  },
                })
              )
          : []),
      ]);
      result.expired++;
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

  return result;
}
