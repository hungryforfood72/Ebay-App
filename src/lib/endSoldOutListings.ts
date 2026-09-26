import { EbayApiError, getEbayEnvironment, getOfferDetails, withdrawOffer } from "./ebay";
import { prisma } from "./prisma";

export type EndSoldOutResult = {
  ended: number;
  // Sold out in our records but eBay still shows stock — left alone and
  // reported, never ended (stock added on eBay directly, outside the app).
  skipped: string[];
  errors: string[];
};

// Ends listings that have sold out. Cristian never restocks a listing (new
// stock always gets a new listing, since condition and expiration differ
// load to load), and with eBay's Out-of-stock control on, a sold-out
// listing otherwise stays alive: hidden from search, still collecting Best
// Offers, auto-renewing every 30 days.
//
// Only listings this app published itself (ebayOfferId) — per Cristian,
// anything listed outside the app (the older File Exchange CSV uploads,
// the VA's listings) is never touched. Runs at the end of every order sync,
// which is also what flips an item to "sold", so a listing gets ended in
// the same run that records its last sale; anything that failed gets
// retried next run.
export async function endSoldOutListings(): Promise<EndSoldOutResult> {
  const result: EndSoldOutResult = { ended: 0, skipped: [], errors: [] };
  const items = await prisma.item.findMany({
    where: {
      status: "sold",
      listingEndedAt: null,
      ebayOfferId: { not: null },
      ebayEnvironment: getEbayEnvironment(),
    },
    select: { id: true, finalTitle: true, ebayOfferId: true, ebayListingId: true },
  });

  for (const item of items) {
    const label = `${item.finalTitle ?? "Item"} (listing ${item.ebayListingId ?? item.ebayOfferId})`;
    try {
      // Safety check against eBay's own count before ending anything: our
      // records can be behind eBay's (one real listing had 20 on eBay while
      // the app knew about 19, after a unit was moved over by hand).
      const live = await getOfferDetails(item.ebayOfferId!);
      if (!live) {
        result.errors.push(`${label}: couldn't read the listing from eBay, will retry next sync.`);
        continue;
      }
      if (live.offerStatus === "UNPUBLISHED" || live.listingStatus === "ENDED") {
        // Already gone on eBay's side (ended by hand, or by eBay) — just
        // record it so it isn't checked again.
        await prisma.item.update({ where: { id: item.id }, data: { listingEndedAt: new Date() } });
        continue;
      }
      if (live.availableQuantity > 0) {
        result.skipped.push(`${label}: eBay still shows ${live.availableQuantity} available, so it was left up.`);
        continue;
      }
      await withdrawOffer(item.ebayOfferId!);
      await prisma.item.update({ where: { id: item.id }, data: { listingEndedAt: new Date() } });
      result.ended++;
    } catch (e) {
      result.errors.push(`${label}: ${e instanceof EbayApiError || e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
