import { parseBundleComponentUnits, unitsFor } from "../itemUnits";
import { prisma } from "../prisma";
import { productItemsWhere } from "../productItems";
import { upcMatchKeys } from "../upcMatch";
import { RETURN_NOTE_PREFIX, returnedUnitsByUpc } from "./returnReconcile";
import { sortedByUpc } from "./sortBoxes";

// The pack card's real count when a load was sorted into sort boxes first
// (GET /api/pack-suggestion). Server only.

// Good units of this product the sorter put in sort boxes on this load
// (pulled to the listing table or not), less every unit of it saved since:
// listed (on its own or in a bundle) or sold at a walk-up. Units a customer
// return put back as Items, or wrote off, came out of an earlier listing,
// not out of the sort boxes, so they don't count; neither do units listed
// from a dud box (those were never sorted as good). null = nothing sorted
// for it (sorting skipped, or not on this load). latestAt = the last sort
// scan, so a newer typed count can win.
export async function sortedLeft(
  manifestId: string,
  upc: string
): Promise<{ sorted: number; left: number; latestAt: Date } | null> {
  const keys = new Set(upcMatchKeys(upc));
  const stored = [...(await sortedByUpc(manifestId)).entries()].filter(
    ([u]) => u === upc || upcMatchKeys(u).some((k) => keys.has(k))
  );
  const sorted = stored.reduce((sum, [, v]) => sum + v.sorted, 0);
  if (sorted === 0) return null;
  const returnEntry = { startsWith: RETURN_NOTE_PREFIX };
  const [latest, items, bundles, walkups, duds, returned, returnDamaged, returnDud] = await Promise.all([
    prisma.sortBoxEntry.findFirst({
      where: { manifestId, upc: { in: stored.map(([u]) => u) } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    // A no-UPC product's items go by their manifest line (productItems.ts).
    prisma.item.findMany({ where: await productItemsWhere(manifestId, upc), select: { quantity: true, isMultipack: true, packSize: true } }),
    prisma.item.findMany({ where: { manifestId, isBundle: true }, select: { quantity: true, bundleComponents: true } }),
    prisma.manifestWalkupSale.aggregate({ where: { manifestId, upc }, _sum: { quantity: true } }),
    prisma.manifestDudEntry.aggregate({ where: { manifestId, upc }, _sum: { listedUnits: true } }),
    returnedUnitsByUpc(manifestId),
    prisma.manifestDamagedEntry.aggregate({ where: { manifestId, upc, note: returnEntry }, _sum: { quantity: true } }),
    prisma.manifestDudEntry.aggregate({ where: { manifestId, upc, note: returnEntry }, _sum: { quantity: true } }),
  ]);
  const inBundles = bundles.reduce(
    (sum, b) =>
      sum +
      parseBundleComponentUnits(b.bundleComponents)
        .filter((c) => c.upc === upc)
        .reduce((s, c) => s + c.unitsPerBundle * b.quantity, 0),
    0
  );
  // returnedUnitsByUpc takes back both the returned Items and the units a
  // return wrote off; the write-offs aren't Items, so add them back here to
  // leave just the returned Items out.
  const saved =
    items.reduce((sum, i) => sum + unitsFor(i), 0) +
    inBundles +
    (walkups._sum.quantity ?? 0) -
    (duds._sum.listedUnits ?? 0) -
    (returned.get(upc) ?? 0) +
    (returnDamaged._sum.quantity ?? 0) +
    (returnDud._sum.quantity ?? 0);
  return { sorted, left: Math.max(0, sorted - saved), latestAt: latest?.createdAt ?? new Date(0) };
}
