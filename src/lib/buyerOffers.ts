import { cogsMapsFor, costPerListingUnit } from "./cogs";
import { getBestOfferHistory, getListingStatus, getPendingBestOffers, type BestOfferStep, type ReceivedBestOffer } from "./ebay";
import type { OfferEconomics } from "./offerMath";
import { prisma } from "./prisma";
import { typicalSingleLabelCost } from "./shippingCost";
import { estimateLabelCost, zoneForZip3 } from "./shippingZone";
import { retailPrices } from "./shopifySync";
import { getTargetMarginPct } from "./sourcingAgent";

export type BuyerOfferRow = ReceivedBestOffer &
  OfferEconomics & {
    // null for a listing made before the app: no Item row, so no item
    // cost, weight, promotion or retail on file.
    itemId: string | null;
    costKnown: boolean;
    noCostReason: "no_manifest" | "manifest_uncosted" | "not_in_app" | null;
    // How many are left on the listing, the most a counter can ask for.
    available: number;
    zone: number | null;
    weightLbs: number | null;
    localPickupOnly: boolean;
    // Manifest retail for one listing unit (a 3-pack is 3x the unit
    // retail), the same number Shopify shows crossed out. Not checked for
    // believability here, so it's labeled as the manifest's figure.
    retailPrice: number | null;
    packSize: number;
    // Earlier steps between this buyer and us on this listing, oldest
    // first, not counting the pending offer itself.
    history: BestOfferStep[];
  };

// Every pending Best Offer buyers sent. App-tracked listings come with
// item cost, weight and retail; ones from before the app only have what
// eBay says (stock left from GetItem). The VA's listings were all ended
// 2026-10-15, so nothing on the account needs hiding anymore. labelCost is
// for this buyer's zone and the offer's quantity.
export async function pendingBuyerOffers(): Promise<{
  offers: BuyerOfferRow[];
  typicalLabel: number;
  targetMarginPct: number;
}> {
  const pending = await getPendingBestOffers();
  const [items, typicalLabel, targetMarginPct] = await Promise.all([
    prisma.item.findMany({
      where: { ebayListingId: { in: [...new Set(pending.map((o) => o.listingId))] }, status: { in: ["listed", "exported"] } },
    }),
    typicalSingleLabelCost(),
    getTargetMarginPct(),
  ]);
  const byListing = new Map(items.map((i) => [i.ebayListingId!, i]));
  // One history call per listing with a pending offer (and a GetItem for
  // stock on pre-app ones); there are only ever a handful at once.
  const pendingListings = [...new Set(pending.map((o) => o.listingId))];
  const untracked = pendingListings.filter((id) => !byListing.has(id));
  const [cogsMaps, retail, histories, untrackedAvailable] = await Promise.all([
    cogsMapsFor(items.map((i) => i.manifestId)),
    retailPrices(items),
    Promise.all(pendingListings.map(async (id) => [id, await getBestOfferHistory(id)] as const)).then((h) => new Map(h)),
    Promise.all(untracked.map(async (id) => [id, (await getListingStatus(id).catch(() => null))?.available] as const)).then(
      (a) => new Map(a)
    ),
  ]);

  const offers: BuyerOfferRow[] = [];
  for (const o of pending) {
    const history = (histories.get(o.listingId) ?? []).filter(
      (h) => h.userId === o.buyer.userId && h.bestOfferId !== o.bestOfferId
    );
    const zone = o.buyer.country === "US" || o.buyer.country == null ? zoneForZip3(o.buyer.zip3) : null;
    const item = byListing.get(o.listingId);
    if (!item) {
      offers.push({
        ...o,
        itemId: null,
        listPrice: o.buyItNowPrice ?? o.price,
        unitCost: null,
        costKnown: false,
        noCostReason: "not_in_app",
        labelCost: estimateLabelCost({ typicalLabel, weightLbs: null, zone }),
        promotedPercent: null,
        // Unknown if GetItem failed; eBay still checks a counter's quantity.
        available: untrackedAvailable.get(o.listingId) ?? o.quantity,
        zone,
        weightLbs: null,
        localPickupOnly: false,
        retailPrice: null,
        packSize: 1,
        history,
      });
      continue;
    }
    const { cost, costed } = costPerListingUnit(item, cogsMaps);
    const weight = item.weightLbs != null || item.weightOz != null ? (item.weightLbs ?? 0) + (item.weightOz ?? 0) / 16 : null;
    offers.push({
      ...o,
      itemId: item.id,
      listPrice: item.price != null ? Number(item.price) : (o.buyItNowPrice ?? o.price),
      unitCost: costed ? cost : null,
      costKnown: costed,
      noCostReason: costed ? null : item.manifestId ? "manifest_uncosted" : "no_manifest",
      labelCost: item.localPickupOnly
        ? 0
        : estimateLabelCost({ typicalLabel, weightLbs: weight != null ? weight * o.quantity : null, zone }),
      promotedPercent: item.ebayAdId ? item.promotedBidPercentage : null,
      available: Math.max(0, item.quantity - item.soldQuantity),
      zone,
      weightLbs: weight,
      localPickupOnly: item.localPickupOnly,
      retailPrice: retail.get(item.id) ?? null,
      packSize: item.isMultipack && item.packSize ? item.packSize : 1,
      history,
    });
  }
  offers.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

  return { offers, typicalLabel, targetMarginPct };
}
