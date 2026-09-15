import { prisma } from "./prisma";

function unitsFor(item: { quantity: number; isMultipack: boolean; packSize: number | null }): number {
  return item.quantity * (item.isMultipack && item.packSize ? item.packSize : 1);
}

// Simplified per-UPC weighted COGS — same underlying formula as the
// manifest dashboard's per-line weightedCogsPerUnit (value share of the
// load's declared value × landed cost, divided by units actually
// received), but averaged across a UPC's manifest lines rather than the
// manifest route's precise sequential per-line allocation. Fine for a
// monthly summary stat: it only diverges from the exact per-line figure
// when a UPC is split across multiple lines with a partial shortfall, and
// even then it's just an average over the same shared cost pool and unit
// count. $0 (via a null return, treated as 0 by callers) whenever there's
// no manifest to derive a cost from at all, per Cristian's instruction.
export async function cogsPerUnitByManifest(manifestId: string): Promise<Map<string, number>> {
  const manifest = await prisma.manifest.findUnique({
    where: { id: manifestId },
    select: {
      totalLandedCost: true,
      lines: { select: { upc: true, extendedRetail: true } },
      items: { select: { upc: true, quantity: true, isMultipack: true, packSize: true, isBundle: true } },
    },
  });
  const result = new Map<string, number>();
  if (!manifest || manifest.totalLandedCost == null) return result;

  const totalManifestExtendedRetail = manifest.lines.reduce((sum, l) => sum + Number(l.extendedRetail), 0);
  if (totalManifestExtendedRetail === 0) return result;

  const upcs = new Set(manifest.lines.map((l) => l.upc).filter((u): u is string => Boolean(u)));
  for (const upc of upcs) {
    const upcExtendedRetail = manifest.lines
      .filter((l) => l.upc === upc)
      .reduce((sum, l) => sum + Number(l.extendedRetail), 0);
    const upcReceivedUnits = manifest.items
      .filter((i) => !i.isBundle && i.upc === upc)
      .reduce((sum, i) => sum + unitsFor(i), 0);
    if (upcReceivedUnits === 0) continue;
    const valueShare = upcExtendedRetail / totalManifestExtendedRetail;
    result.set(upc, (valueShare * Number(manifest.totalLandedCost)) / upcReceivedUnits);
  }
  return result;
}
