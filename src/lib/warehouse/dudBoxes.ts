import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { WarehouseError } from "./bins";
import { DUD_BOX_CODE_PREFIX, dudBoxName, loadBoxCode, nextLoadBoxNumber, normalizeCode } from "./codes";
import { upcMatchKeys } from "../upcMatch";
import type { DudListDecision } from "./dudBoxTypes";

// Dud boxes (DudBox, ManifestDudEntry.dudBoxId). The sorter puts duds in a
// box tied to the manifest (the listing station's set-asides go in one
// too); later someone decides each entry, and the Shopify and eBay ones get
// listed from the box at the listing station. A Shopify one is set to
// Shopify only without the lister having to know.

type Tx = Prisma.TransactionClient;

// Starts a dud box for a load: the load's next box number (its old
// DB0001-style boxes count too), QR code DB-<load>-<n>. Serialized so two
// sorters starting a box at once can't get the same number.
export async function createDudBox(args: { manifestId: string; by: string | null }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('warehouse_create_dud_box'))`;
    const existing = await tx.dudBox.findMany({ where: { manifestId: args.manifestId }, select: { code: true } });
    const next = nextLoadBoxNumber(existing.map((b) => b.code));
    return tx.dudBox.create({
      data: { code: loadBoxCode(DUD_BOX_CODE_PREFIX, args.manifestId, next), manifestId: args.manifestId, createdBy: args.by },
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

// Units of this product decided for listing (Shopify or eBay) and not
// listed yet, for the pack card while listing from the box. null = no such
// box, or nothing of it to list there.
export async function dudBoxUnitsLeft(rawCode: string, upc: string): Promise<{ manifestId: string; left: number } | null> {
  const box = await prisma.dudBox.findUnique({ where: { code: normalizeCode(rawCode) }, select: { id: true, manifestId: true } });
  if (!box) return null;
  const wanted = new Set(upcMatchKeys(upc));
  const entries = await prisma.manifestDudEntry.findMany({
    where: { dudBoxId: box.id, decision: { in: ["shopify", "ebay"] } },
    select: { upc: true, quantity: true, listedUnits: true },
  });
  const left = entries
    .filter((e) => upcMatchKeys(e.upc).some((k) => wanted.has(k)))
    .reduce((sum, e) => sum + Math.max(0, e.quantity - e.listedUnits), 0);
  return left > 0 ? { manifestId: box.manifestId, left } : null;
}

// Which way this product gets listed from the box: "shopify" (Shopify &
// Whatnot only) or "ebay", by the decision on its entries with units left.
// Both left (logged twice, decided differently): the lister's pick,
// shopifyOnly or not. null = nothing decided for listing, or all listed.
export async function dudListDecision(
  db: Tx | typeof prisma,
  args: { boxId: string; upc: string; wantShopify: boolean }
): Promise<DudListDecision | null> {
  const wanted = new Set(upcMatchKeys(args.upc));
  const entries = await db.manifestDudEntry.findMany({
    where: { dudBoxId: args.boxId, decision: { in: ["shopify", "ebay"] } },
    select: { upc: true, quantity: true, listedUnits: true, decision: true },
  });
  const open = new Set(
    entries
      .filter((e) => e.quantity > e.listedUnits && upcMatchKeys(e.upc).some((k) => wanted.has(k)))
      .map((e) => e.decision as DudListDecision)
  );
  if (open.size === 0) return null;
  if (open.size === 1) return [...open][0];
  return args.wantShopify ? "shopify" : "ebay";
}

// Called by POST /api/items inside its transaction when an item is listed
// from a dud box: takes `units` physical units off the box's entries for
// this UPC that were decided `decision` ("shopify" or "ebay"), oldest
// first, so the manifest counts them as received instead of dud. Refuses
// (nothing changes) if the box doesn't have that many units of this
// product left for that decision.
export async function claimDudUnits(
  tx: Tx,
  args: { dudBoxCode: string; upc: string; units: number; decision: DudListDecision }
): Promise<{ manifestId: string; dudBoxCode: string }> {
  if (!Number.isInteger(args.units) || args.units < 1) throw new WarehouseError("That's not a real unit count.");
  const box = await findDudBox(tx, args.dudBoxCode);
  // Lock this box's entries so two listers can't both list the last unit.
  await tx.$executeRaw`SELECT id FROM "ManifestDudEntry" WHERE "dudBoxId" = ${box.id} FOR UPDATE`;
  const entries = await tx.manifestDudEntry.findMany({
    where: { dudBoxId: box.id, decision: args.decision },
    orderBy: { createdAt: "asc" },
  });
  const wanted = new Set(upcMatchKeys(args.upc));
  const matching = entries.filter((e) => upcMatchKeys(e.upc).some((k) => wanted.has(k)));
  const left = matching.reduce((sum, e) => sum + (e.quantity - e.listedUnits), 0);
  if (matching.length === 0) {
    throw new WarehouseError(
      `This product isn't marked for ${args.decision === "ebay" ? "eBay" : "Shopify"} in ${dudBoxName(box.code)}. Ask whoever processes duds to decide it first.`
    );
  }
  if (left < args.units) {
    throw new WarehouseError(`${dudBoxName(box.code)} only has ${left} of this product left to list, not ${args.units}.`);
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
