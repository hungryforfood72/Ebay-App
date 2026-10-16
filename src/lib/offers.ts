import { cogsMapsFor, costPerListingUnit } from "./cogs";
import { getListingStatus, getOfferEligibleListingIds } from "./ebay";
import type { OfferEconomics } from "./offerMath";
import { prisma } from "./prisma";
import { typicalSingleLabelCost } from "./shippingCost";
import { getTargetMarginPct } from "./sourcingAgent";

export type EligibleOfferListing = OfferEconomics & {
  // null for a listing made before the app: no Item row, so no item cost
  // or promotion on file, just what eBay says about it.
  itemId: string | null;
  listingId: string;
  title: string;
  costKnown: boolean;
  // Why there's no item cost, so the dashboard can say so: scanned outside
  // a manifest (counted as $0, per Cristian), its manifest has no landed
  // cost entered yet (or doesn't list this UPC), or listed before the app.
  noCostReason: "no_manifest" | "manifest_uncosted" | "not_in_app" | null;
  lastOffer: { discountPercent: number; offerPrice: number; buyerCount: number; sentAt: string } | null;
};

function lastOfferOf(sent: { discountPercent: unknown; offerPrice: unknown; buyerCount: number; sentAt: Date } | undefined) {
  return sent
    ? {
        discountPercent: Number(sent.discountPercent),
        offerPrice: Number(sent.offerPrice),
        buyerCount: sent.buyerCount,
        sentAt: sent.sentAt.toISOString(),
      }
    : null;
}

// Every listing eBay says is eligible for offers to interested buyers.
// App-tracked ones (published by it, or CSV-uploaded and linked up) come
// with their item cost; ones from before the app are filled in from eBay
// (GetItem) and have no item cost. The VA's listings were all ended
// 2026-10-15, so nothing on the account needs hiding anymore.
export async function eligibleOfferListings(): Promise<{
  listings: EligibleOfferListing[];
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
  const tracked = new Set(items.map((i) => i.ebayListingId));
  const untrackedIds = eligibleIds.filter((id) => !tracked.has(id));
  const [cogsMaps, untracked, untrackedSent] = await Promise.all([
    cogsMapsFor(items.map((i) => i.manifestId)),
    Promise.all(untrackedIds.map(async (id) => ({ id, live: await getListingStatus(id).catch(() => null) }))),
    prisma.sentOffer.findMany({ where: { listingId: { in: untrackedIds } }, orderBy: { sentAt: "desc" } }),
  ]);

  const appListings: EligibleOfferListing[] = items
    .filter((i) => i.price != null && i.soldQuantity < i.quantity)
    .map((i) => {
      const { cost, costed } = costPerListingUnit(i, cogsMaps);
      return {
        itemId: i.id,
        listingId: i.ebayListingId!,
        title: i.finalTitle ?? i.sku,
        listPrice: Number(i.price),
        unitCost: costed ? cost : null,
        costKnown: costed,
        noCostReason: costed ? null : i.manifestId ? ("manifest_uncosted" as const) : ("no_manifest" as const),
        labelCost: i.localPickupOnly ? 0 : labelCost,
        promotedPercent: i.ebayAdId ? i.promotedBidPercentage : null,
        lastOffer: lastOfferOf(i.sentOffers[0]),
      };
    });

  const otherListings: EligibleOfferListing[] = untracked
    .filter(({ live }) => live != null && live.active && live.available > 0 && live.price != null)
    .map(({ id, live }) => ({
      itemId: null,
      listingId: id,
      title: live!.title ?? id,
      listPrice: live!.price!,
      unitCost: null,
      costKnown: false,
      noCostReason: "not_in_app" as const,
      labelCost,
      promotedPercent: null,
      lastOffer: lastOfferOf(untrackedSent.find((s) => s.listingId === id)),
    }));

  const listings = [...appListings, ...otherListings].sort((a, b) => b.listPrice - a.listPrice);
  return { listings, targetMarginPct };
}
