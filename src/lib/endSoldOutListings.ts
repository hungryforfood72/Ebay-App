import {
  EbayApiError,
  endFixedPriceItem,
  getEbayEnvironment,
  getListingStatus,
  getOfferDetails,
  withdrawOffer,
} from "./ebay";
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
// Every listing this app has an Item for: ones it published itself
// (ebayOfferId) and the older File Exchange CSV uploads it linked up
// (ebayListingId only). The VA's listings never have an Item here at all
// (order sync only matches by our own SKU), so they're never touched — per
// Cristian, that's the line. Runs at the end of every order sync, which is
// also what flips an item to "sold", so a listing gets ended in the same
// run that records its last sale; anything that failed gets retried next
// run.
export async function endSoldOutListings(): Promise<EndSoldOutResult> {
  const result: EndSoldOutResult = { ended: 0, skipped: [], errors: [] };
  const items = await prisma.item.findMany({
    where: {
      status: "sold",
      listingEndedAt: null,
      OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }],
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
      const live = await liveState(item);
      if (!live) {
        result.errors.push(`${label}: couldn't read the listing from eBay, will retry next sync.`);
        continue;
      }
      if (!live.active) {
        // Already gone on eBay's side (ended by hand, or by eBay) — just
        // record it so it isn't checked again.
        await prisma.item.update({ where: { id: item.id }, data: { listingEndedAt: new Date() } });
        continue;
      }
      if (live.available > 0) {
        result.skipped.push(`${label}: eBay still shows ${live.available} available, so it was left up.`);
        continue;
      }
      if (item.ebayOfferId) await withdrawOffer(item.ebayOfferId);
      else await endFixedPriceItem(item.ebayListingId!);
      await prisma.item.update({ where: { id: item.id }, data: { listingEndedAt: new Date() } });
      result.ended++;
    } catch (e) {
      result.errors.push(`${label}: ${e instanceof EbayApiError || e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

async function liveState(item: {
  ebayOfferId: string | null;
  ebayListingId: string | null;
}): Promise<{ available: number; active: boolean } | null> {
  if (item.ebayOfferId) {
    const offer = await getOfferDetails(item.ebayOfferId);
    if (!offer) return null;
    // Offer status, not listing.listingStatus: confirmed live that the
    // latter keeps its last value (OUT_OF_STOCK) after the listing ends.
    return {
      available: offer.availableQuantity,
      active: offer.offerStatus !== "UNPUBLISHED" && offer.listingStatus !== "ENDED",
    };
  }
  return getListingStatus(item.ebayListingId!);
}
