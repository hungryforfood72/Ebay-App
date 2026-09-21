// Shared "how many physical units does this Item actually represent"
// logic — extracted from src/app/api/manifests/[id]/route.ts so the
// expiration sweep (src/lib/expireListings.ts) uses the exact same
// bundle/multipack conversion instead of a second, driftable copy. A
// mismatch here was a real bug earlier (bundle components were being
// silently excluded from manifest reconciliation) — one source of truth
// avoids that class of bug recurring.

// A multipack Item's "quantity" is in packs, not physical units — "3 of a
// 2-pack = 6 units" is the conversion Cristian described.
export function unitsFor(item: { quantity: number; isMultipack: boolean; packSize: number | null }): number {
  return item.quantity * (item.isMultipack && item.packSize ? item.packSize : 1);
}

// Same multipack expansion, for the eBay-order-derived soldQuantity — an
// eBay listing's quantity is "how many of this listing" (pack count), the
// same scale as Item.quantity, not the already-expanded physical-unit
// scale unitsFor produces.
export function soldUnitsFor(item: { soldQuantity: number; isMultipack: boolean; packSize: number | null }): number {
  return item.soldQuantity * (item.isMultipack && item.packSize ? item.packSize : 1);
}

export type BundleComponentUnits = { upc: string; unitsPerBundle: number };

// bundleComponents is stored as loose Json ({ upc, quantity, photoUrls,
// name, upcLookupData, expirationDate }[] — see Item.bundleComponents in
// schema.prisma), so this validates shape defensively rather than trusting
// it. Components with no UPC (a "mystery" item with nothing scannable) or
// a non-positive quantity contribute nothing — there's no manifest line
// they could ever match.
export function parseBundleComponentUnits(json: unknown): BundleComponentUnits[] {
  if (!Array.isArray(json)) return [];
  const result: BundleComponentUnits[] = [];
  for (const raw of json) {
    if (typeof raw !== "object" || raw === null) continue;
    const upc = "upc" in raw ? String((raw as { upc?: unknown }).upc ?? "") : "";
    const quantity = "quantity" in raw ? Number((raw as { quantity?: unknown }).quantity) : NaN;
    if (upc && Number.isFinite(quantity) && quantity > 0) {
      result.push({ upc, unitsPerBundle: quantity });
    }
  }
  return result;
}
