import { parseBundleComponentUnits } from "./itemUnits";
import { prisma } from "./prisma";
import { getShopifyPricing, MAX_RETAIL_TO_EBAY, queueShopifySync, retailPrices, shopifyPriceFor } from "./shopifySync";

// Review's "Retail to check" list. Manifest retail drives the Epic Steals
// price (50% off retail) and its crossed-out "Retail" price, so a wrong one
// shows up two ways:
// - too high: over MAX_RETAIL_TO_EBAY x the eBay price, so the store hides
//   it (Nexcare DUO at $21 a box, really $8.99).
// - too low: under half the eBay price, so 50% off it crashes the store
//   price (a $4.06-retail plush that sells for $25.99 went for $2.03).
// Cristian types the real retail per unit, or says it's right; either way
// the line is marked checked and drops off the list.
const LOW_RETAIL_SHARE = 0.5;

export type RetailCheckLine = {
  manifestId: string;
  upc: string;
  description: string;
  unitRetail: number;
  // Units of this UPC in one listing (a 3-pack is 3).
  units: number;
};

export type RetailCheckRow = {
  itemId: string;
  title: string;
  photoUrl: string | null;
  ebayPrice: number;
  retail: number;
  storePrice: number;
  reason: "too_high" | "too_low";
  lines: RetailCheckLine[];
};

function listingParts(item: {
  upc: string | null;
  isBundle: boolean;
  bundleComponents: unknown;
  isMultipack: boolean;
  packSize: number | null;
}): { upc: string; units: number }[] {
  if (item.isBundle) {
    // A bundle can list the same UPC twice (split by expiration date).
    const byUpc = new Map<string, number>();
    for (const c of parseBundleComponentUnits(item.bundleComponents)) byUpc.set(c.upc, (byUpc.get(c.upc) ?? 0) + c.unitsPerBundle);
    return [...byUpc].map(([upc, units]) => ({ upc, units }));
  }
  return item.upc ? [{ upc: item.upc, units: item.isMultipack && item.packSize ? item.packSize : 1 }] : [];
}

export async function retailCheckList(): Promise<RetailCheckRow[]> {
  const items = (
    await prisma.item.findMany({
      where: {
        status: { in: ["listed", "exported"] },
        listingEndedAt: null,
        expiredAt: null,
        manifestId: { not: null },
        price: { not: null },
        OR: [{ ebayOfferId: { not: null } }, { ebayListingId: { not: null } }, { shopifyOnly: true }],
      },
      orderBy: { updatedAt: "desc" },
    })
  ).filter((i) => i.quantity > i.soldQuantity);
  const [retail, pricing] = await Promise.all([retailPrices(items), getShopifyPricing()]);
  const lines = await prisma.manifestLine.findMany({
    where: { OR: items.flatMap((i) => listingParts(i).map((p) => ({ manifestId: i.manifestId!, upc: p.upc }))) },
    select: { manifestId: true, upc: true, description: true, retailPrice: true, retailCheckedAt: true },
  });

  const rows: RetailCheckRow[] = [];
  for (const i of items) {
    const packRetail = retail.get(i.id);
    if (packRetail == null) continue;
    const ebayPrice = Number(i.price);
    const ebayOriginal = Number(i.originalPrice ?? i.price);
    const reason =
      Math.round(packRetail * 100) > Math.round(ebayOriginal * MAX_RETAIL_TO_EBAY * 100)
        ? "too_high"
        : packRetail < ebayPrice * LOW_RETAIL_SHARE
          ? "too_low"
          : null;
    if (!reason) continue;
    const itemLines: RetailCheckLine[] = [];
    let allChecked = true;
    for (const p of listingParts(i)) {
      const line = lines.find((l) => l.manifestId === i.manifestId && l.upc === p.upc && Number(l.retailPrice) > 0);
      if (!line) continue;
      if (!line.retailCheckedAt) allChecked = false;
      itemLines.push({ manifestId: line.manifestId, upc: p.upc, description: line.description, unitRetail: Number(line.retailPrice), units: p.units });
    }
    if (allChecked) continue;
    rows.push({
      itemId: i.id,
      title: i.finalTitle ?? i.sku,
      photoUrl: i.photoUrls[0] ?? null,
      ebayPrice,
      retail: Math.round(packRetail * 100) / 100,
      storePrice: shopifyPriceFor(ebayPrice, ebayOriginal, packRetail, pricing),
      reason,
      lines: itemLines,
    });
  }
  return rows;
}

// Sets one UPC's retail on one manifest (every line it's on, if the file
// split it), or with unitRetail null just marks it checked. The supplier's
// figure is kept the first time it's changed. Items using it get their
// Shopify price redone now rather than at the next sync.
export async function setLineRetail(manifestId: string, upc: string, unitRetail: number | null): Promise<number> {
  const lines = await prisma.manifestLine.findMany({ where: { manifestId, upc } });
  const now = new Date();
  await prisma.$transaction(
    lines.map((l) =>
      prisma.manifestLine.update({
        where: { id: l.id },
        data:
          unitRetail == null || Number(l.retailPrice) === unitRetail
            ? { retailCheckedAt: now }
            : { retailPrice: unitRetail, supplierRetailPrice: l.supplierRetailPrice ?? l.retailPrice, retailCheckedAt: now },
      })
    )
  );
  const affected = await prisma.item.findMany({
    where: { manifestId, shopifyProductId: { not: null }, OR: [{ upc }, { isBundle: true }] },
    select: { id: true, upc: true, isBundle: true, bundleComponents: true },
  });
  queueShopifySync(
    affected.filter((i) => i.upc === upc || (i.isBundle && parseBundleComponentUnits(i.bundleComponents).some((c) => c.upc === upc))).map((i) => i.id)
  );
  return lines.length;
}
