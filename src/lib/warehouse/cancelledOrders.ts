import type { Item, Prisma } from "@/generated/prisma/client";
import { prisma } from "../prisma";
import { getItemLocations, removeUnitsBestEffort, WarehouseError } from "./bins";
import { buildItemLabel, queueItemLabels } from "./itemLabel";
import { itemTitle, sameConditionCopy } from "./returns";

// A cancelled order whose listing had already ended (Cristian, 2026-11-06).
// The account has eBay's Out-of-stock control off, so the last unit
// selling ends the listing for good: when that order is then cancelled,
// the unit is still here but has nowhere to sell. It's recorded as an
// ItemReturn waiting to be relisted, listed on the Returns page and the
// dashboard, and one tap there makes a fresh copy of the listing (new item
// code, labels at the station, into Review), the same way a same-condition
// return of an ended listing does. Never the old listing again.
export const CANCELLED_DECISION = "cancelled";

type CancelReport = { cancelled: true; lineItemId: string | null };

// Truly stranded: the listing ended because it sold out. A past-date item
// also has listingEndedAt (off eBay, still on the store) and an expired one
// was written off, so a cancelled order on either just goes back the way
// it was, nothing to relist.
export function strandedByCancel(item: Pick<Item, "listingEndedAt" | "pastDateAt" | "expiredAt">): boolean {
  return Boolean(item.listingEndedAt && !item.pastDateAt && !item.expiredAt);
}

// The ItemReturn row to create with the sale's reversal (same transaction,
// so it can't be lost), or null when that order line is already flagged.
export async function cancelledReturnData(args: {
  itemId: string;
  channel: "shopify" | "ebay";
  orderName: string;
  lineItemId: string | null;
  units: number;
}): Promise<Prisma.ItemReturnUncheckedCreateInput | null> {
  // Once per order line, even if the cancellation is read again.
  const already = await prisma.itemReturn.findFirst({
    where: args.lineItemId
      ? { itemId: args.itemId, report: { path: ["lineItemId"], equals: args.lineItemId } }
      : { itemId: args.itemId, channel: args.channel, orderId: args.orderName, report: { path: ["cancelled"], equals: true } },
    select: { id: true },
  });
  if (already) return null;
  const report: CancelReport = { cancelled: true, lineItemId: args.lineItemId };
  return {
    itemId: args.itemId,
    channel: args.channel,
    orderId: args.orderName,
    units: args.units,
    sameCondition: true,
    decision: CANCELLED_DECISION,
    reason: "Order cancelled after its listing had already ended. Relist it as a new listing.",
    report: report as unknown as Prisma.InputJsonValue,
  };
}

export type CancelledToRelist = {
  id: string;
  createdAt: string;
  title: string;
  sku: string;
  photoUrl: string | null;
  units: number;
  channel: string | null;
  orderId: string | null;
  // Where the units are: picked ones are with the packed order, the rest
  // still in the bin or on the shelf.
  pickedUnits: number;
  where: string | null;
};

// Units of the order line already picked (one OrderPick row per unit).
async function pickedCount(report: unknown, channel: string | null): Promise<number> {
  const lineItemId = (report as CancelReport | null)?.lineItemId;
  if (!lineItemId) return 0;
  return await prisma.orderPick.count({ where: { channel: channel ?? "shopify", lineItemId } });
}

export async function listCancelledToRelist(): Promise<CancelledToRelist[]> {
  const rows = await prisma.itemReturn.findMany({
    where: { decision: CANCELLED_DECISION },
    orderBy: { createdAt: "asc" },
    take: 50,
    include: { item: { select: { id: true, sku: true, finalTitle: true, aiTitle: true, upc: true, photoUrls: true, shelfLocation: true } } },
  });
  const locations = await getItemLocations(rows.map((r) => r.item));
  return await Promise.all(
    rows.map(async (r) => {
      const pickedUnits = Math.min(r.units, await pickedCount(r.report, r.channel));
      const loc = locations.get(r.item.id);
      const where =
        pickedUnits >= r.units
          ? null
          : loc?.bins.length
            ? loc.bins.map((b) => (b.shelfLabel ? `${b.binCode} on ${b.shelfLabel}` : b.binCode)).join(", ")
            : loc?.legacyShelf
              ? `Shelf ${loc.legacyShelf}`
              : null;
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        title: itemTitle(r.item),
        sku: r.item.sku,
        photoUrl: r.item.photoUrls[0] ?? null,
        units: r.units,
        channel: r.channel,
        orderId: r.orderId,
        pickedUnits,
        where,
      };
    })
  );
}

// The fresh copy. The old item hands its units over (quantity down, so it
// reads sold out again and nothing counts them twice), and the units nobody
// picked come out of the old item's bins too: the new labels go on them and
// they're binned again under the new code.
export async function relistCancelledOrder(args: {
  returnId: string;
  stationId: string;
  by: string | null;
}): Promise<{ newItem: { id: string; sku: string }; labelsQueued: number; units: number }> {
  if (!args.stationId) throw new WarehouseError("Pick a station first, so the new labels print there.");
  const station = await prisma.station.findUnique({ where: { id: args.stationId }, select: { id: true } });
  if (!station) throw new WarehouseError("That station doesn't exist anymore. Pick a station again.", 404);
  const row = await prisma.itemReturn.findUnique({ where: { id: args.returnId }, include: { item: true } });
  if (!row || row.decision !== CANCELLED_DECISION) {
    throw new WarehouseError("That one was already relisted. Refresh the page.", 409);
  }
  const item = row.item;
  if (item.pastDateAt || item.expiredAt) {
    await prisma.itemReturn.updateMany({
      where: { id: row.id, decision: CANCELLED_DECISION },
      data: { decision: "cancelled_skipped", reason: "Past-date or expired: nothing to relist on eBay." },
    });
    throw new WarehouseError("That one is past-date or expired, so there's nothing to relist. It's off the list now.", 409);
  }
  const pickedUnits = Math.min(row.units, await pickedCount(row.report, row.channel));
  const label = await buildItemLabel(prisma, { ...item, sku: "" });

  const { created, labelsQueued } = await prisma.$transaction(
    async (tx) => {
      // Only while still waiting, so a double tap can't make two copies.
      const claimed = await tx.itemReturn.updateMany({
        where: { id: row.id, decision: CANCELLED_DECISION },
        data: { decision: "relist_same" },
      });
      if (claimed.count === 0) throw new WarehouseError("That one was already relisted. Refresh the page.", 409);
      // The old item's count, locked: two relists of the same item can't
      // both write the same number, and a unit sold or removed since the
      // cancellation can't be copied.
      const [fresh] = await tx.$queryRaw<{ quantity: number; soldQuantity: number }[]>`
        SELECT quantity, "soldQuantity" FROM "Item" WHERE id = ${item.id} FOR UPDATE`;
      if (!fresh || fresh.quantity - fresh.soldQuantity < row.units) {
        throw new WarehouseError("That unit was sold or moved since the order was cancelled. Ask Cristian.", 409);
      }
      const created = await tx.item.create({ data: await sameConditionCopy(tx, item, row.units, args.by) });
      const labelsQueued = await queueItemLabels(tx, {
        stationId: args.stationId,
        payload: { ...label, code: created.sku },
        copies: row.units,
        by: args.by,
      });
      const newQuantity = fresh.quantity - row.units;
      await tx.item.update({
        where: { id: item.id },
        data: { quantity: newQuantity, ...(newQuantity <= fresh.soldQuantity ? { status: "sold" as const } : {}) },
      });
      await tx.itemReturn.update({
        where: { id: row.id },
        data: {
          newItemId: created.id,
          recordedBy: args.by,
          reason: `Order ${row.orderId ?? ""} cancelled after its listing ended: new copy of the listing.`.replace("  ", " "),
        },
      });
      return { created, labelsQueued };
    },
    { maxWait: 10_000, timeout: 20_000 }
  );

  // The units nobody picked are still in the old item's bins.
  const inBins = row.units - pickedUnits;
  if (inBins > 0) {
    await removeUnitsBestEffort({
      itemId: item.id,
      units: inBins,
      kind: "adjust",
      by: args.by,
      note: `Relisted as ${created.sku} after cancelled order ${row.orderId ?? ""}`.trim(),
    });
  }
  return { newItem: { id: created.id, sku: created.sku }, labelsQueued, units: row.units };
}
