import { FALLBACK_FEE_FIXED, FALLBACK_FEE_RATE } from "./packSize";

// eBay's floor for an offer to interested buyers.
export const MIN_OFFER_PERCENT = 5;
export const MAX_OFFER_PERCENT = 80;

export type OfferEconomics = {
  listPrice: number;
  // One listing unit (a pack, a bundle) at manifest COGS; null when there's
  // no cost to go on (no manifest, or no landed cost entered yet).
  unitCost: number | null;
  labelCost: number;
  // Promoted Listings fee charged on the sale price, if it's promoted.
  promotedPercent: number | null;
};

// Offer price and what one sale at it leaves after eBay's fees, the
// promotion fee, the label and the item's own cost. Shared by the dashboard
// (live as the % changes) and the send route (which refuses a losing offer),
// so both always agree. Same fee estimate as the set-aside rule (packSize).
export function offerOutcome(e: OfferEconomics, discountPercent: number) {
  const offerPrice = Math.round(e.listPrice * (1 - discountPercent / 100) * 100) / 100;
  const fees = offerPrice * (FALLBACK_FEE_RATE + (e.promotedPercent ?? 0) / 100) + FALLBACK_FEE_FIXED;
  const profit = offerPrice - fees - e.labelCost - (e.unitCost ?? 0);
  return { offerPrice, profit };
}
