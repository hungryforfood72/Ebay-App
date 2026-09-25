import { parseBundleComponentUnits, unitsFor } from "./itemUnits";
import { prisma } from "./prisma";

// Simplified per-UPC weighted COGS — same underlying formula as the
// manifest dashboard's per-line weightedCogsPerUnit (value share of the
// load's declared value × landed cost, divided by units actually
// received), but averaged across a UPC's manifest lines rather than the
// manifest route's precise sequential per-line allocation. Fine for a
// summary stat: it only diverges from the exact per-line figure when a
// UPC is split across multiple lines with a partial shortfall, and even
// then it's just an average over the same shared cost pool and unit
// count. "Received" counts the same things the manifest route does:
// single/multipack items, units inside bundles, and walk-up sales. No
// entry for a UPC (treated as $0 by callers) whenever there's no manifest
// or landed cost to derive a cost from, per Cristian's instruction.
export async function cogsPerUnitByManifest(manifestId: string): Promise<Map<string, number>> {
  const manifest = await prisma.manifest.findUnique({
    where: { id: manifestId },
    select: {
      totalLandedCost: true,
      lines: { select: { upc: true, extendedRetail: true } },
      items: {
        select: {
          upc: true,
          quantity: true,
          isMultipack: true,
          packSize: true,
          isBundle: true,
          bundleComponents: true,
        },
      },
      walkupSales: { select: { upc: true, quantity: true } },
    },
  });
  const result = new Map<string, number>();
  if (!manifest || manifest.totalLandedCost == null) return result;

  const totalManifestExtendedRetail = manifest.lines.reduce((sum, l) => sum + Number(l.extendedRetail), 0);
  if (totalManifestExtendedRetail === 0) return result;

  const receivedByUpc = new Map<string, number>();
  const add = (upc: string, units: number) => receivedByUpc.set(upc, (receivedByUpc.get(upc) ?? 0) + units);
  for (const item of manifest.items) {
    if (item.isBundle) {
      for (const c of parseBundleComponentUnits(item.bundleComponents)) add(c.upc, c.unitsPerBundle * item.quantity);
    } else if (item.upc) {
      add(item.upc, unitsFor(item));
    }
  }
  for (const w of manifest.walkupSales) add(w.upc, w.quantity);

  const upcs = new Set(manifest.lines.map((l) => l.upc).filter((u): u is string => Boolean(u)));
  for (const upc of upcs) {
    const upcExtendedRetail = manifest.lines
      .filter((l) => l.upc === upc)
      .reduce((sum, l) => sum + Number(l.extendedRetail), 0);
    const upcReceivedUnits = receivedByUpc.get(upc) ?? 0;
    if (upcReceivedUnits === 0) continue;
    const valueShare = upcExtendedRetail / totalManifestExtendedRetail;
    result.set(upc, (valueShare * Number(manifest.totalLandedCost)) / upcReceivedUnits);
  }
  return result;
}

// Loads each distinct manifest's per-UPC cost map once, for callers that
// cost many items across several manifests.
export async function cogsMapsFor(manifestIds: (string | null)[]): Promise<Map<string, Map<string, number>>> {
  const ids = [...new Set(manifestIds.filter((id): id is string => Boolean(id)))];
  return new Map(await Promise.all(ids.map(async (id) => [id, await cogsPerUnitByManifest(id)] as const)));
}

type CostableItem = {
  manifestId: string | null;
  upc: string | null;
  isMultipack: boolean;
  packSize: number | null;
  isBundle: boolean;
  bundleComponents: unknown;
};

// Cost of ONE listing unit of an item (one pack, one bundle) from its
// manifest's per-UPC costs. `costed` is false when any part of it has no
// cost to go on (no manifest, no landed cost yet, UPC not on the manifest),
// so callers can say how much of a total is really a $0 placeholder.
export function costPerListingUnit(
  item: CostableItem,
  cogsMaps: Map<string, Map<string, number>>
): { cost: number; costed: boolean } {
  const map = item.manifestId ? cogsMaps.get(item.manifestId) : undefined;
  if (!map) return { cost: 0, costed: false };
  if (item.isBundle) {
    const components = parseBundleComponentUnits(item.bundleComponents);
    let cost = 0;
    let costed = components.length > 0;
    for (const c of components) {
      const perUnit = map.get(c.upc);
      if (perUnit == null) costed = false;
      else cost += perUnit * c.unitsPerBundle;
    }
    return { cost, costed };
  }
  const perUnit = item.upc ? map.get(item.upc) : undefined;
  if (perUnit == null) return { cost: 0, costed: false };
  return { cost: perUnit * (item.isMultipack && item.packSize ? item.packSize : 1), costed: true };
}
