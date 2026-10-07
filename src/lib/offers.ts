import { cogsMapsFor, costPerListingUnit } from "./cogs";
import { getOfferEligibleListingIds } from "./ebay";
import type { OfferEconomics } from "./offerMath";
import { prisma } from "./prisma";
import { typicalSingleLabelCost } from "./shippingCost";
import { getTargetMarginPct } from "./sourcingAgent";

export type EligibleOfferListing = OfferEconomics & {
  itemId: string;
  listingId: string;
  title: string;
  costKnown: boolean;
  lastOffer: { discountPercent: number; offerPrice: number; buyerCount: number; sentAt: string } | null;
};

// Listings eBay says are eligible for offers to interested buyers, kept to
// the ones this app tracks: published by it or CSV-uploaded and linked up.
// The VA's listings and ones from before the app are never shown, the same
// line as auto-ending sold-out listings.
export async function eligibleOfferListings(): Promise<{
  listings: EligibleOfferListing[];
  eligibleOnAccount: number;
  targetMarginPct: number;
}> {
  const eligibleIds = await getOfferEligibleListingIds();
  const [items, labelCost, targetMarginPct] = await Promise.all([
    prisma.item.findMany({
      where: { ebayListingId: { in: eligibleIds }, status: { in: ["listed", "exported"] } },
      include: { sentOffers: { orderBy: { sentAt: "desc" }, take: 1 } },
    }),
    typicalSingleLabelCost(),
    getTargetMarginPct(),
  ]);
  const cogsMaps = await cogsMapsFor(items.map((i) => i.manifestId));

  const listings = items
    .filter((i) => i.price != null && i.soldQuantity < i.quantity)
    .map((i) => {
      const { cost, costed } = costPerListingUnit(i, cogsMaps);
      const last = i.sentOffers[0];
      return {
        itemId: i.id,
        listingId: i.ebayListingId!,
        title: i.finalTitle ?? i.sku,
        listPrice: Number(i.price),
        unitCost: costed ? cost : null,
        costKnown: costed,
        labelCost,
        promotedPercent: i.ebayAdId ? i.promotedBidPercentage : null,
        lastOffer: last
          ? {
              discountPercent: Number(last.discountPercent),
              offerPrice: Number(last.offerPrice),
              buyerCount: last.buyerCount,
              sentAt: last.sentAt.toISOString(),
            }
          : null,
      };
    })
    .sort((a, b) => b.listPrice - a.listPrice);

  return { listings, eligibleOnAccount: eligibleIds.length, targetMarginPct };
}
