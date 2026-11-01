import { logActivity } from "./activityLog";
import { createMarkdownPromotion, getEbayEnvironment, getMarkdownListingStatus, markdownsOnListing } from "./ebay";
import { prisma } from "./prisma";

export const MARKDOWN_SKIPPED_PREFIX = "eBay didn't apply this sale:";

// A skip for this reason clears up on its own once eBay finishes resetting
// the listing from an earlier sale (it lags the sale's end time by a few
// minutes), so it's worth starting the sale again.
const STILL_MARKED_DOWN = /already marked down/i;
// Wait this long after the skip before restarting, so eBay has reset the
// price from the earlier sale (3.5 minutes behind its end time, seen live).
const RESTART_AFTER_MS = 5 * 60 * 1000;
// Restarts per sale before leaving it to a person, so a skip that never
// clears can't make a new eBay promotion every 10 minutes forever. Counted
// from the activity log: the "Auto" restarts since someone last started,
// updated or ended the sale by hand.
const MAX_RESTARTS = 3;
const AUTO_USER = "Auto";

type CheckedItem = {
  id: string;
  sku: string;
  finalTitle: string | null;
  ebayListingId: string | null;
  ebayMarkdownId: string | null;
  ebayMarkdownError: string | null;
  markdownPercentOff: number | null;
  markdownEndsAt: Date | null;
  photoUrls: string[];
};

// Checks that every sale event the app started really reached its listing.
// eBay reports a sale RUNNING even when it skipped the only listing in it
// (Hershey's, 2026-10-13: shown as 30% off on the dashboard for a day while
// buyers saw full price), so the promotion's own status can't be trusted.
// A skip lands in ebayMarkdownError, which the dashboard shows on the item;
// it clears once eBay reports the listing marked down. Runs with every
// order sync. Items whose sale started under 2 minutes ago are left for
// next time, since eBay takes ~30s to process one.
//
// A skip because the listing was still marked down from the sale before
// (Coloplast pouch, 2026-11-01: 25% -> 35% update) gets the sale started
// again on its own, same % and end date, once eBay has caught up (5
// minutes after the skip), so the discount is live within the next sync or
// two instead of waiting for a person.
export async function checkMarkdowns(): Promise<{ skipped: number; restarted: number; errors: string[] }> {
  const items = await prisma.item.findMany({
    where: {
      ebayMarkdownId: { not: null },
      ebayListingId: { not: null },
      ebayEnvironment: getEbayEnvironment(),
      markdownStartedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
      markdownEndsAt: { gt: new Date() },
    },
    select: {
      id: true,
      sku: true,
      finalTitle: true,
      ebayListingId: true,
      ebayMarkdownId: true,
      ebayMarkdownError: true,
      markdownPercentOff: true,
      markdownEndsAt: true,
      photoUrls: true,
    },
  });
  let skipped = 0;
  let restarted = 0;
  const errors: string[] = [];
  for (const item of items) {
    try {
      const result = await getMarkdownListingStatus(item.ebayMarkdownId!, item.ebayListingId!);
      if (!result) continue;
      if (result.status === "SKIPPED") {
        const reason = result.message ?? "eBay skipped the listing.";
        const retryable = STILL_MARKED_DOWN.test(reason) && (await restartsSoFar(item.id)) < MAX_RESTARTS;
        if (retryable && Date.now() - result.changedAt.getTime() < RESTART_AFTER_MS) continue;
        let restartFailed: string | null = null;
        if (retryable) {
          try {
            if (await restartSale(item)) {
              restarted++;
              continue;
            }
          } catch (e) {
            // On the card, not just in the sync's errors: nobody reads those.
            restartFailed = e instanceof Error ? e.message : String(e);
            errors.push(`${item.ebayListingId}: restarting the skipped sale failed: ${restartFailed}`);
          }
        }
        skipped++;
        const message = restartFailed
          ? `${MARKDOWN_SKIPPED_PREFIX} ${reason} Restarting it on its own failed: ${restartFailed}`
          : `${MARKDOWN_SKIPPED_PREFIX} ${reason} Hit Update to start it again.`;
        if (item.ebayMarkdownError !== message) {
          await prisma.item.update({ where: { id: item.id }, data: { ebayMarkdownError: message } });
        }
      } else if (result.status === "MARKED_DOWN" && item.ebayMarkdownError?.startsWith(MARKDOWN_SKIPPED_PREFIX)) {
        await prisma.item.update({ where: { id: item.id }, data: { ebayMarkdownError: null } });
      }
    } catch (e) {
      errors.push(`${item.ebayListingId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { skipped, restarted, errors };
}

// Starts the same sale again (same % and end date) next to the skipped
// one. The skipped sale stays on the listing until its end date, since eBay
// won't end a sale less than a day old, but it never touches the price and
// doesn't stop a new one (confirmed live 2026-11-01 on the Coloplast pouch:
// the new 35% sale was applied about 7 minutes after it was created).
// false = not restarted (a real sale is on the listing, or the item is
// missing what a sale needs); the skip message stays for a person.
async function restartSale(item: CheckedItem): Promise<boolean> {
  const listingId = item.ebayListingId!;
  const percentOff = item.markdownPercentOff;
  const endDate = item.markdownEndsAt;
  const photo = item.photoUrls[0];
  if (!percentOff || !endDate || !photo || endDate.getTime() - Date.now() < 60 * 60 * 1000) return false;
  const others = (await markdownsOnListing(listingId)).filter((p) => p.promotionId !== item.ebayMarkdownId && !p.skipped);
  if (others.length > 0) return false;

  const promotion = await createMarkdownPromotion(listingId, percentOff, endDate, `${percentOff}% off for a limited time!`.slice(0, 50), photo);
  await prisma.item.update({
    where: { id: item.id },
    data: {
      ebayMarkdownId: promotion.promotionId,
      markdownStartedAt: new Date(promotion.startDate),
      markdownEndsAt: new Date(promotion.endDate),
      ebayMarkdownError: null,
    },
  });
  await logActivity(
    { username: AUTO_USER },
    {
      action: "item.sale",
      summary: `Restarted the ${percentOff}% off eBay sale on ${item.finalTitle ?? item.sku}: eBay skipped it while the earlier sale's price was still on the listing`,
      targetType: "item",
      targetId: item.id,
      before: { promotionId: item.ebayMarkdownId },
      after: { promotionId: promotion.promotionId, startsAt: promotion.startDate },
    }
  );
  return true;
}

// Auto restarts of this item's sale since a person last touched it.
async function restartsSoFar(itemId: string): Promise<number> {
  const lastByHand = await prisma.activityLog.findFirst({
    where: { targetId: itemId, action: "item.sale", NOT: { username: AUTO_USER } },
    orderBy: { at: "desc" },
    select: { at: true },
  });
  return prisma.activityLog.count({
    where: { targetId: itemId, action: "item.sale", username: AUTO_USER, ...(lastByHand ? { at: { gt: lastByHand.at } } : {}) },
  });
}
