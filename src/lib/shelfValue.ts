import { cogsMapsFor, costPerListingUnit } from "./cogs";
import { parseBundleComponentUnits, unitsFor } from "./itemUnits";
import { prisma } from "./prisma";

// Cash tied up in stock sitting on the shelf: every scanned item not yet
// sold through (pending review, ready, exported, listed) × its manifest
// COGS. Expired items are left out on purpose: the daily sweep ends the
// listing and writes the remaining units off as damaged on the manifest,
// so they're no longer sellable stock.
const ON_SHELF_STATUSES = ["pending_review", "ready", "exported", "listed"] as const;
type OnShelfStatus = (typeof ON_SHELF_STATUSES)[number];

type Bucket = {
  listings: number;
  units: number;
  cost: number;
  // Units with no cost to go on (no manifest, no landed cost entered yet,
  // or a UPC that isn't on its manifest). Counted at $0 in `cost`.
  uncostedUnits: number;
};

export type ShelfValue = Bucket & {
  // Same stock at its own listing price, for comparison. Only items that
  // have a price yet (pending-review items often don't).
  listValue: number;
  unpricedUnits: number;
  byStatus: (Bucket & { status: OnShelfStatus })[];
  byManifest: (Bucket & { manifestId: string | null; title: string })[];
};

const emptyBucket = (): Bucket => ({ listings: 0, units: 0, cost: 0, uncostedUnits: 0 });

export async function shelfValue(): Promise<ShelfValue> {
  const items = await prisma.item.findMany({
    where: { status: { in: [...ON_SHELF_STATUSES] } },
    select: {
      status: true,
      quantity: true,
      soldQuantity: true,
      price: true,
      manifestId: true,
      upc: true,
      isMultipack: true,
      packSize: true,
      isBundle: true,
      bundleComponents: true,
      manifest: { select: { title: true } },
    },
  });

  const cogsMaps = await cogsMapsFor(items.map((i) => i.manifestId));
  const total = { ...emptyBucket(), listValue: 0, unpricedUnits: 0 };
  const byStatus = new Map<OnShelfStatus, Bucket>();
  const byManifest = new Map<string | null, Bucket & { title: string }>();

  for (const item of items) {
    // Listing units still on hand (packs, bundles). soldQuantity is on the
    // same scale — see Item.soldQuantity.
    const available = Math.max(0, item.quantity - item.soldQuantity);
    if (available === 0) continue;
    const units = item.isBundle
      ? parseBundleComponentUnits(item.bundleComponents).reduce((sum, c) => sum + c.unitsPerBundle, 0) * available
      : unitsFor({ ...item, quantity: available });
    const { cost, costed } = costPerListingUnit(item, cogsMaps);

    const status = item.status as OnShelfStatus;
    const manifestKey = item.manifestId;
    if (!byStatus.has(status)) byStatus.set(status, emptyBucket());
    if (!byManifest.has(manifestKey)) {
      byManifest.set(manifestKey, { ...emptyBucket(), title: item.manifest?.title ?? "No manifest" });
    }
    for (const b of [total, byStatus.get(status)!, byManifest.get(manifestKey)!]) {
      b.listings++;
      b.units += units;
      b.cost += cost * available;
      if (!costed) b.uncostedUnits += units;
    }
    if (item.price != null) total.listValue += Number(item.price) * available;
    else total.unpricedUnits += units;
  }

  return {
    ...total,
    byStatus: ON_SHELF_STATUSES.filter((s) => byStatus.has(s)).map((status) => ({ status, ...byStatus.get(status)! })),
    byManifest: [...byManifest.entries()]
      .map(([manifestId, b]) => ({ manifestId, ...b }))
      .sort((a, b) => b.cost - a.cost || b.units - a.units),
  };
}
