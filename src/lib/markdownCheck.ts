import { getEbayEnvironment, getMarkdownListingStatus } from "./ebay";
import { prisma } from "./prisma";

export const MARKDOWN_SKIPPED_PREFIX = "eBay didn't apply this sale:";

// Checks that every sale event the app started really reached its listing.
// eBay reports a sale RUNNING even when it skipped the only listing in it
// (Hershey's, 2026-10-13: shown as 30% off on the dashboard for a day while
// buyers saw full price), so the promotion's own status can't be trusted.
// A skip lands in ebayMarkdownError, which the dashboard shows on the item;
// it clears once eBay reports the listing marked down. Runs with every
// order sync. Items whose sale started under 2 minutes ago are left for
// next time, since eBay takes ~30s to process one.
export async function checkMarkdowns(): Promise<{ skipped: number; errors: string[] }> {
  const items = await prisma.item.findMany({
    where: {
      ebayMarkdownId: { not: null },
      ebayListingId: { not: null },
      ebayEnvironment: getEbayEnvironment(),
      markdownStartedAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
      markdownEndsAt: { gt: new Date() },
    },
    select: { id: true, ebayListingId: true, ebayMarkdownId: true, ebayMarkdownError: true },
  });
  let skipped = 0;
  const errors: string[] = [];
  for (const item of items) {
    try {
      const result = await getMarkdownListingStatus(item.ebayMarkdownId!, item.ebayListingId!);
      if (!result) continue;
      if (result.status === "SKIPPED") {
        skipped++;
        const message = `${MARKDOWN_SKIPPED_PREFIX} ${result.message ?? "eBay skipped the listing."} End it and start it again.`;
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
  return { skipped, errors };
}
