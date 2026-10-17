import { prisma } from "../prisma";
import { classifyScan } from "./codes";

// Warehouse items can't be marked ready or published until every unit is
// in a bin (Cristian, 2026-10-17). The lister only bags and labels; the bags
// get binned later at the binning station. If a listing went live first, an
// order could come in for a bag that's still loose on the binning table, and
// the bin counts would never line up. Holding review until it's binned means
// nothing sells before the system knows where it is.
//
// Only items with a printed label (ES code sku) are held. Items listed the
// old way have a shelf location and no bins, so they're never blocked.

export type BinProgress = { inBins: number; needed: number };

// Units of each labelled item still to bin. Items not in the map aren't
// warehouse items (or are fully binned when needed <= inBins).
export async function binProgress(
  items: { id: string; sku: string; quantity: number; soldQuantity: number }[]
): Promise<Map<string, BinProgress>> {
  const labelled = items.filter((i) => classifyScan(i.sku) === "item");
  const map = new Map<string, BinProgress>();
  if (labelled.length === 0) return map;
  const sums = await prisma.binContent.groupBy({
    by: ["itemId"],
    where: { itemId: { in: labelled.map((i) => i.id) } },
    _sum: { units: true },
  });
  const inBins = new Map(sums.map((s) => [s.itemId, s._sum.units ?? 0]));
  for (const i of labelled) {
    map.set(i.id, { inBins: inBins.get(i.id) ?? 0, needed: Math.max(0, i.quantity - i.soldQuantity) });
  }
  return map;
}

// The message to refuse "ready"/publish with, or null if it's fine to go.
export async function binGateError(item: {
  id: string;
  sku: string;
  quantity: number;
  soldQuantity: number;
}): Promise<string | null> {
  const p = (await binProgress([item])).get(item.id);
  if (!p || p.inBins >= p.needed) return null;
  return p.inBins === 0
    ? "No bin assigned yet. Scan its labels into a bin at the binning station first."
    : `Only ${p.inBins} of ${p.needed} units are in a bin. Scan the rest into a bin first.`;
}
