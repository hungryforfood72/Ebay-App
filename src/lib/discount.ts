import type { Prisma } from "@/generated/prisma/client";
import { getLiveListingPrice } from "./ebay";

// Shared by the manifest bulk-discount route and the single-item discount
// route — the $0.99 floor is a correctness constant worth keeping in one
// place, even though the two routes' surrounding logic (loop over a
// manifest vs. act on one item) differs enough to stay separate.
// basePrice is the price before any discount (discountBasePrice below), so
// the result is always "value off the original": 40% after an earlier 15%
// is 40% off, not 49%. A value of 0 means back to the original price.
export function computeDiscountedPrice(basePrice: number, mode: "percent" | "amount", value: number): number {
  const raw = mode === "percent" ? basePrice * (1 - value / 100) : basePrice - value;
  return Math.max(raw, 0.99);
}

// The price a discount is taken off: the one saved by the first discount,
// else eBay's own "was" price when it shows one above the current price
// (listings discounted before originalPrice existed: confirmed live
// 2026-10-06, eBay reported a $29.99 original on a listing at $17.99), else
// the current price. The caller saves it as originalPrice.
export async function discountBasePrice(item: {
  price: Prisma.Decimal | null;
  originalPrice: Prisma.Decimal | null;
  ebayListingId: string | null;
}): Promise<number> {
  if (item.originalPrice != null) return Number(item.originalPrice);
  const current = Number(item.price ?? 0);
  if (item.ebayListingId) {
    const live = await getLiveListingPrice(item.ebayListingId).catch(() => null);
    if (live?.originalPrice && live.originalPrice > current) return live.originalPrice;
  }
  return current;
}
