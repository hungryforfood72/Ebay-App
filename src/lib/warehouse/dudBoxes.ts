import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { WarehouseError } from "./bins";
import { codeNumber, DUD_BOX_CODE_PREFIX, formatDudBoxCode, normalizeCode } from "./codes";
import { upcMatchKeys } from "../upcMatch";

// Dud boxes (DudBox, ManifestDudEntry.dudBoxId). The sorter puts duds in a
// box tied to the manifest; later someone decides each entry, and the
// Shopify ones get listed from the box at the listing station, where the
// item is set to Shopify & Whatnot only without the lister having to know.

type Tx = Prisma.TransactionClient;

// Next free dud box code (DB0001...). Serialized so two sorters starting a
// box at once can't get the same code.
export async function createDudBox(args: { manifestId: string; by: string | null }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('warehouse_create_dud_box'))`;
    const existing = await tx.dudBox.findMany({ select: { code: true } });
    const next = Math.max(0, ...existing.map((b) => codeNumber(b.code, DUD_BOX_CODE_PREFIX) ?? 0)) + 1;
    return tx.dudBox.create({
      data: { code: formatDudBoxCode(next), manifestId: args.manifestId, createdBy: args.by },
    });
  });
}

export async function findDudBox(tx: Tx | typeof prisma, rawCode: string) {
  const code = normalizeCode(rawCode);
  const box = await tx.dudBox.findUnique({ where: { code } });
  if (!box) throw new WarehouseError(`No dud box with code ${code}. Check the label.`, 404);
  return box;
}

// Physical units of a listing: a 3-pack listing with quantity 2 is 6 units,
// which is what dud entries count.
export function physicalUnits(item: { quantity: number; isMultipack?: boolean | null; packSize?: number | null }): number {
  return item.quantity * (item.isMultipack && item.packSize ? item.packSize : 1);
}

// Called by POST /api/items inside its transaction when an item is listed
// from a dud box: takes `units` physical units off the box's entries for
// this UPC that were decided "shopify", oldest first, so the manifest counts
// them as received instead of dud. Refuses (nothing changes) if the box
// doesn't have that many Shopify-decided units of this product left.
export async function claimDudUnits(
  tx: Tx,
  args: { dudBoxCode: string; upc: string; units: number }
): Promise<{ manifestId: string; dudBoxCode: string }> {
  const box = await findDudBox(tx, args.dudBoxCode);
  // Lock this box's entries so two listers can't both list the last unit.
  await tx.$executeRaw`SELECT id FROM "ManifestDudEntry" WHERE "dudBoxId" = ${box.id} FOR UPDATE`;
  const entries = await tx.manifestDudEntry.findMany({
    where: { dudBoxId: box.id, decision: "shopify" },
    orderBy: { createdAt: "asc" },
  });
  const wanted = new Set(upcMatchKeys(args.upc));
  const matching = entries.filter((e) => upcMatchKeys(e.upc).some((k) => wanted.has(k)));
  const left = matching.reduce((sum, e) => sum + (e.quantity - e.listedUnits), 0);
  if (matching.length === 0) {
    throw new WarehouseError(`This product isn't marked for Shopify in dud box ${box.code}. Ask whoever processes duds to decide it first.`);
  }
  if (left < args.units) {
    throw new WarehouseError(`Dud box ${box.code} only has ${left} of this product left to list, not ${args.units}.`);
  }
  let need = args.units;
  for (const e of matching) {
    if (need === 0) break;
    const take = Math.min(need, e.quantity - e.listedUnits);
    if (take <= 0) continue;
    await tx.manifestDudEntry.update({ where: { id: e.id }, data: { listedUnits: { increment: take } } });
    need -= take;
  }
  return { manifestId: box.manifestId, dudBoxCode: box.code };
}
