import { FALLBACK_SHIPPING_COST } from "./packSize";
import { prisma } from "./prisma";

const LOOKBACK_DAYS = 90;
const MIN_SALES = 10;

// What a label for one item really costs Cristian: the median label on his
// own single-unit eBay sales over the last 90 days, falling back to the
// flat estimate until there are enough of them. Measured 2026-09-28: $13.39
// median on 44 single-unit sales, and the 7 sales under $12 averaged a
// $9.10 sale, $1.97 fees and an $11.61 label, so each lost about $4.50
// before the item's own cost. The flat $5 hid that.
export async function typicalSingleLabelCost(): Promise<number> {
  const sales = await prisma.ebayItemSale.findMany({
    where: {
      quantity: 1,
      shipping: { gt: 0 },
      soldAt: { gte: new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) },
      item: { isMultipack: false, isBundle: false },
    },
    select: { shipping: true },
  });
  if (sales.length < MIN_SALES) return FALLBACK_SHIPPING_COST;
  const labels = sales.map((s) => Number(s.shipping)).sort((a, b) => a - b);
  const mid = Math.floor(labels.length / 2);
  return labels.length % 2 === 0 ? (labels[mid - 1] + labels[mid]) / 2 : labels[mid];
}
