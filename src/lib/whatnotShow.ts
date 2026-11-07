import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { normalizeCode } from "./warehouse/codes";
import { removeUnits, WarehouseError } from "./warehouse/bins";
import { getShow, listOrders, type WhatnotOrder, type WhatnotOrderItem } from "./whatnot";
import { recordGiveaway } from "./whatnotGiveaways";

// Sorting a live Whatnot show by buyer (Cristian, 2026-11-07). Each buyer
// gets a reusable show box (ShowBox, "WHATNOT SHOW BOX 23") on their first
// buy of the show, and everything they win after goes in the same box, so
// after the show each box is one buyer's whole order: packing mode
// (whatnotPack.ts) checks it by scan and prints the label.
//
// How a sale gets to its box:
// - Every order placed in a show is recorded here as it comes in (the
//   orders webhook, or the show screen's own check of the latest orders):
//   one ShowSale per line, the buyer (ShowBuyer) and their box.
// - Runner mode: the runner scans the item's label after it sells; the
//   screen says which box, and the unit comes off its Whatnot bin's count.
// - Solo mode (a switch on the show screen): nobody scans; each unit comes
//   off its bin's count as the sale arrives and the screen shows the box.
//
// Lock order: the show's lock (showLock), then bin locks (removeUnits), so
// nothing that holds a bin lock ever waits on a show.

type Tx = Prisma.TransactionClient;

const SOLO_KEY = "whatnot.showSolo";
const POLLED_KEY = "whatnot.showPolledAt";
// How often the show screen's check reads Whatnot's latest orders, at most
// (the webhook is the main way in; this covers a slow or missed one).
const POLL_EVERY_MS = 4_000;

export async function getSoloMode(): Promise<boolean> {
  return (await prisma.appSetting.findUnique({ where: { key: SOLO_KEY } }))?.value === "1";
}

export async function setSoloMode(on: boolean): Promise<void> {
  const value = on ? "1" : "0";
  await prisma.appSetting.upsert({ where: { key: SOLO_KEY }, create: { key: SOLO_KEY, value }, update: { value } });
}

async function showLock(tx: Tx, showId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`whatnot_show:${showId}`}))`;
}

// Show titles, read once per server instance.
const titles = new Map<string, string>();
async function showTitle(showId: string): Promise<string | null> {
  if (titles.has(showId)) return titles.get(showId)!;
  try {
    const show = await getShow(showId);
    titles.set(showId, show.title.slice(0, 200));
    return titles.get(showId)!;
  } catch {
    return null;
  }
}

// The same person across their orders in a show: their Whatnot user, or
// (when the API token can't see buyers) the shipment Whatnot puts their
// show purchases on.
export function buyerKeyFor(order: WhatnotOrder, lines: WhatnotOrderItem[]): string {
  if (order.buyer?.id) return `user:${order.buyer.id}`;
  const shipment = lines.find((l) => l.shipment_id)?.shipment_id;
  return shipment ? `shipment:${shipment}` : `order:${order.id}`;
}

function saleType(order: WhatnotOrder): string {
  const t = order.transaction_type;
  return t === "auction" || t === "giveaway" || t === "buy_it_now" ? t : "other";
}

function isCancelled(order: WhatnotOrder): boolean {
  return Boolean(order.cancelled_at) || order.status === "cancelled" || order.status === "failed";
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

// The box new units go in: the buyer's newest box still in use, else the
// lowest-numbered free one. null = every box is in use.
async function ensureBox(tx: Tx, buyerId: string): Promise<number | null> {
  const current = await tx.showBoxAssignment.findFirst({
    where: { buyerId, releasedAt: null },
    orderBy: { seq: "desc" },
    include: { box: { select: { number: true } } },
  });
  if (current) return current.box.number;
  return await assignNewBox(tx, buyerId);
}

async function assignNewBox(tx: Tx, buyerId: string): Promise<number | null> {
  // Boxes are shared by every show: one lock for handing them out.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('whatnot_show_boxes'))`;
  const free = await tx.showBox.findFirst({
    where: { assignments: { none: { releasedAt: null } } },
    orderBy: { number: "asc" },
  });
  if (!free) return null;
  const last = await tx.showBoxAssignment.findFirst({ where: { buyerId }, orderBy: { seq: "desc" }, select: { seq: true } });
  await tx.showBoxAssignment.create({ data: { boxId: free.id, buyerId, seq: (last?.seq ?? 0) + 1 } });
  return free.number;
}

// Makes boxes 1..n that don't exist yet (owner, Whatnot page). Returns the
// numbers made.
export async function makeShowBoxes(upTo: number): Promise<number[]> {
  if (!Number.isInteger(upTo) || upTo < 1 || upTo > 300) throw new WarehouseError("Make between 1 and 300 show boxes.");
  const have = new Set((await prisma.showBox.findMany({ select: { number: true } })).map((b) => b.number));
  const numbers = Array.from({ length: upTo }, (_, i) => i + 1).filter((n) => !have.has(n));
  if (numbers.length) await prisma.showBox.createMany({ data: numbers.map((number) => ({ number })), skipDuplicates: true });
  return numbers;
}

// "Box full" on the show screen: the buyer gets another box, and their next
// units go in it. Both stay theirs until packed.
export async function nextBoxForBuyer(buyerId: string): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const buyer = await tx.showBuyer.findUnique({ where: { id: buyerId }, select: { showId: true, packedAt: true } });
    if (!buyer) throw new WarehouseError("That buyer isn't in a show anymore.", 404);
    if (buyer.packedAt) throw new WarehouseError("That buyer's order is already packed.", 409);
    await showLock(tx, buyer.showId);
    // A slip of the finger shouldn't hand one buyer every free box.
    const holding = await tx.showBoxAssignment.count({ where: { buyerId, releasedAt: null } });
    if (holding >= 5) throw new WarehouseError("That buyer already has 5 show boxes. Use a big box from the floor instead.", 409);
    const n = await assignNewBox(tx, buyerId);
    if (n == null) throw new WarehouseError("Every show box is in use. Make more on the Whatnot page.", 409);
    return n;
  });
}

// Frees a buyer's boxes (packed, or nothing left to ship).
export async function releaseBoxes(tx: Tx | typeof prisma, buyerId: string): Promise<void> {
  await tx.showBoxAssignment.updateMany({ where: { buyerId, releasedAt: null }, data: { releasedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Orders coming in
// ---------------------------------------------------------------------------

// One order placed in a show (from processWhatnotOrder, after the sale or
// giveaway was recorded). matched = order item id -> the app's item.
export async function recordShowOrder(
  order: WhatnotOrder,
  lines: WhatnotOrderItem[],
  matched: Map<string, string>
): Promise<void> {
  const showId = order.show_id;
  if (!showId) return;
  const cancelled = isCancelled(order);
  const buyerKey = buyerKeyFor(order, lines);
  const buyerName = order.buyer?.username ?? null;
  const title = await showTitle(showId);
  const newSaleIds: string[] = [];
  // Giveaways linked by the runner's scan (no SKU on the order): order sync
  // can't match them, so their cancel is put back from here.
  const cancelledGiveaways: { itemId: string; orderItemId: string; quantity: number; soldAt: Date }[] = [];
  await prisma.$transaction(
    async (tx) => {
      await showLock(tx, showId);
      let buyer = await tx.showBuyer.findUnique({ where: { showId_buyerKey: { showId, buyerKey } } });
      if (!buyer) {
        // A cancelled order from someone with nothing else: nothing to sort.
        if (cancelled) return;
        buyer = await tx.showBuyer.create({ data: { showId, showTitle: title, buyerKey, buyerName } });
      } else if ((buyerName && !buyer.buyerName) || (title && !buyer.showTitle)) {
        buyer = await tx.showBuyer.update({
          where: { id: buyer.id },
          data: { buyerName: buyer.buyerName ?? buyerName, showTitle: buyer.showTitle ?? title },
        });
      }
      for (const line of lines) {
        if (line.quantity < 1) continue;
        const itemId = matched.get(line.id) ?? null;
        const existing = await tx.showSale.findUnique({ where: { orderItemId: line.id } });
        if (existing) {
          const data: Prisma.ShowSaleUpdateInput = {};
          if (cancelled && !existing.cancelledAt) {
            data.cancelledAt = order.cancelled_at ? new Date(order.cancelled_at) : new Date();
            if (existing.saleType === "giveaway" && existing.itemId && !matched.has(line.id)) {
              cancelledGiveaways.push({ itemId: existing.itemId, orderItemId: existing.orderItemId, quantity: existing.quantity, soldAt: existing.soldAt });
            }
          }
          if (!existing.itemId && itemId) data.item = { connect: { id: itemId } };
          if (line.shipment_id && line.shipment_id !== existing.shipmentId) data.shipmentId = line.shipment_id;
          if (Object.keys(data).length) await tx.showSale.update({ where: { id: existing.id }, data });
          continue;
        }
        if (cancelled) continue;
        const sale = await tx.showSale.create({
          data: {
            showId,
            buyerId: buyer.id,
            orderId: order.id,
            orderItemId: line.id,
            saleType: saleType(order),
            title: (line.purchased_item?.title ?? "Whatnot item").slice(0, 300),
            sku: line.purchased_item?.sku?.trim() || line.variant_external_id?.trim() || line.product_external_id?.trim() || null,
            quantity: line.quantity,
            itemId,
            shipmentId: line.shipment_id ?? null,
            soldAt: new Date(order.created_at),
          },
        });
        newSaleIds.push(sale.id);
      }
      // Bought more after their order was packed: it's back on the packing
      // list (a new label for the new shipment; the old one stays printed).
      if (newSaleIds.length && buyer.packedAt) {
        buyer = await tx.showBuyer.update({
          where: { id: buyer.id },
          data: { packedAt: null, packedBy: null, labelRequestedAt: null, labelPrintedAt: null, labelError: null, labelShipmentIds: [] },
        });
      }
      if (!cancelled) await ensureBox(tx, buyer.id);
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  for (const g of cancelledGiveaways) {
    await recordGiveaway({ ...g, orderId: order.id, givenAt: g.soldAt, showId, cancelled: true }).catch((e) =>
      console.error(`[whatnot show] giveaway cancel ${g.orderItemId}`, e)
    );
  }
  // Solo mode: nobody scans, so each unit comes off its bin now.
  if (newSaleIds.length && (await getSoloMode())) {
    for (const id of newSaleIds) {
      await sortSale(id, "solo mode").catch((e) => console.error(`[whatnot show] solo sort ${id}`, e));
    }
  }
}

// Puts the sale's units in the buyer's box: off the Whatnot bin's count.
// Returns the box number.
async function sortSale(saleId: string, by: string | null): Promise<{ box: number | null; fromBin: string | null }> {
  return await prisma.$transaction(
    async (tx) => {
      const sale = await tx.showSale.findUniqueOrThrow({ where: { id: saleId } });
      await showLock(tx, sale.showId);
      const fresh = await tx.showSale.findUniqueOrThrow({ where: { id: saleId } });
      const box = await ensureBox(tx, fresh.buyerId);
      if (fresh.cancelledAt || fresh.sortedUnits >= fresh.quantity) return { box, fromBin: fresh.fromBinCode };
      const units = fresh.quantity - fresh.sortedUnits;
      const taken = fresh.itemId
        ? await removeUnits(tx, { itemId: fresh.itemId, units, kind: "pick", by, note: `Whatnot show box ${box ?? "?"}` })
        : [];
      const fromBin = taken[0]?.binCode ?? fresh.fromBinCode ?? null;
      await tx.showSale.update({
        where: { id: saleId },
        data: { sortedUnits: fresh.quantity, sortedAt: new Date(), sortedBy: by, fromBinCode: fromBin, boxNumber: box },
      });
      return { box, fromBin };
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
}

// ---------------------------------------------------------------------------
// The show screen
// ---------------------------------------------------------------------------

// Reads Whatnot's newest orders and records any for this show the app
// hasn't seen (or that were cancelled since), at most every few seconds
// across every screen. The webhook normally gets there first.
export async function refreshShowOrders(showId: string, force = false): Promise<void> {
  const now = Date.now();
  if (!force) {
    await prisma.appSetting.upsert({ where: { key: POLLED_KEY }, create: { key: POLLED_KEY, value: "0" }, update: {} });
    const claim = await prisma.appSetting.updateMany({
      where: { key: POLLED_KEY, value: { lt: String(now - POLL_EVERY_MS).padStart(15, "0") } },
      data: { value: String(now).padStart(15, "0") },
    });
    if (claim.count === 0) return;
  }
  const { processWhatnotOrder } = await import("./whatnotSync");
  const { items } = await listOrders();
  const mine = items.filter((o) => o.show_id === showId);
  if (mine.length === 0) return;
  const known = await prisma.showSale.findMany({
    where: { orderId: { in: mine.map((o) => o.id) } },
    select: { orderId: true, cancelledAt: true },
  });
  for (const order of mine) {
    const rows = known.filter((k) => k.orderId === order.id);
    const seen = rows.length > 0;
    const cancelSeen = rows.every((r) => r.cancelledAt);
    if (seen && (!isCancelled(order) || cancelSeen)) continue;
    // A cancelled order never seen before has nothing to sort.
    if (!seen && isCancelled(order)) continue;
    await processWhatnotOrder(order.id).catch((e) => console.error(`[whatnot show] order ${order.id}`, e));
  }
}

export type ShowSaleView = {
  id: string;
  title: string;
  code: string | null;
  photo: string | null;
  saleType: string;
  quantity: number;
  sortedUnits: number;
  cancelled: boolean;
  soldAt: string;
  box: number | null;
  buyer: string;
  // The app doesn't know what it is (made in the show, not by the app).
  unknown: boolean;
};

export type ShowBuyerView = {
  id: string;
  name: string;
  boxes: number[];
  units: number;
  sortedUnits: number;
  packed: boolean;
};

export type ShowFeed = {
  showId: string;
  solo: boolean;
  boxCount: number;
  freeBoxes: number;
  buyers: ShowBuyerView[];
  recent: ShowSaleView[];
  // Sold units nobody has put in a box yet (runner mode).
  waiting: number;
};

export function buyerLabel(b: { buyerName: string | null; buyerKey: string }, index?: number): string {
  if (b.buyerName) return `@${b.buyerName}`;
  return index != null ? `Buyer ${index + 1}` : "Buyer";
}

export async function showFeed(showId: string): Promise<ShowFeed> {
  const [solo, boxCount, freeBoxes, buyers] = await Promise.all([
    getSoloMode(),
    prisma.showBox.count(),
    prisma.showBox.count({ where: { assignments: { none: { releasedAt: null } } } }),
    prisma.showBuyer.findMany({
      where: { showId },
      orderBy: { createdAt: "asc" },
      include: {
        boxes: { where: { releasedAt: null }, orderBy: { seq: "asc" }, include: { box: { select: { number: true } } } },
        sales: {
          orderBy: { soldAt: "desc" },
          include: { item: { select: { sku: true, photoUrls: true, finalTitle: true, aiTitle: true } } },
        },
      },
    }),
  ]);
  const buyerViews: ShowBuyerView[] = [];
  const recent: ShowSaleView[] = [];
  let waiting = 0;
  buyers.forEach((b, i) => {
    const name = buyerLabel(b, i);
    const boxes = b.boxes.map((a) => a.box.number);
    const live = b.sales.filter((s) => !s.cancelledAt);
    buyerViews.push({
      id: b.id,
      name,
      boxes,
      units: live.reduce((n, s) => n + s.quantity, 0),
      sortedUnits: live.reduce((n, s) => n + Math.min(s.sortedUnits, s.quantity), 0),
      packed: b.packedAt != null,
    });
    for (const s of b.sales) {
      if (!s.cancelledAt) waiting += Math.max(0, s.quantity - s.sortedUnits);
      recent.push({
        id: s.id,
        title: s.item?.finalTitle ?? s.item?.aiTitle ?? s.title,
        code: s.item?.sku ?? null,
        photo: s.item?.photoUrls[0] ?? null,
        saleType: s.saleType,
        quantity: s.quantity,
        sortedUnits: s.sortedUnits,
        cancelled: s.cancelledAt != null,
        soldAt: s.soldAt.toISOString(),
        box: s.boxNumber ?? boxes[boxes.length - 1] ?? null,
        buyer: name,
        unknown: s.itemId == null,
      });
    }
  });
  recent.sort((a, b) => b.soldAt.localeCompare(a.soldAt));
  return { showId, solo, boxCount, freeBoxes, buyers: buyerViews, recent: recent.slice(0, 25), waiting };
}

export type SortScanResult =
  | {
      status: "sorted";
      box: number | null;
      boxes: number[];
      buyer: string;
      buyerId: string;
      // This buyer's first unit in the show: a new box comes out.
      firstForBuyer: boolean;
      title: string;
      code: string;
      giveaway: boolean;
    }
  // No sale for it yet (the auction just ended, or it didn't sell). The
  // screen asks again every couple of seconds. sortedBox = a unit of the
  // same item already went to this box (scanned the same bag twice?).
  | { status: "waiting"; title: string; code: string; sortedBox: number | null }
  | { status: "not_item"; message: string };

// The runner scanned an item's label after it sold.
export async function sortScan(showId: string, rawCode: string, by: string | null, opts?: { refresh?: boolean }): Promise<SortScanResult> {
  const code = normalizeCode(rawCode);
  const item = await prisma.item.findUnique({
    where: { sku: code },
    select: { id: true, sku: true, finalTitle: true, aiTitle: true, whatnotGiveaway: true },
  });
  if (!item) return { status: "not_item", message: `Nothing in the app has the code ${code}. Scan the ES label on the bag.` };
  const title = item.finalTitle ?? item.aiTitle ?? item.sku;

  const find = async () => {
    const own = await prisma.showSale.findFirst({
      where: { showId, itemId: item.id, cancelledAt: null, sortedUnits: { lt: prisma.showSale.fields.quantity } },
      orderBy: { soldAt: "asc" },
    });
    if (own) return own;
    // A giveaway whose order didn't carry the SKU: the oldest giveaway win
    // the app couldn't match goes with the giveaway item in the runner's hand.
    if (item.whatnotGiveaway) {
      return await prisma.showSale.findFirst({
        where: { showId, saleType: "giveaway", itemId: null, cancelledAt: null, sortedUnits: 0 },
        orderBy: { soldAt: "asc" },
      });
    }
    return null;
  };

  let sale = await find();
  if (!sale && opts?.refresh) {
    await refreshShowOrders(showId);
    sale = await find();
  }
  // Two people scanning two bags of the same item at once can both find the
  // same sale; the one that loses looks again for the next.
  let box: number | null = null;
  let firstForBuyer = false;
  let done = false;
  for (let attempt = 0; sale && attempt < 4; attempt++) {
    // A giveaway matched by the scan: link it and take it out of stock.
    if (!sale.itemId) {
      const linked = await prisma.showSale.updateMany({ where: { id: sale.id, itemId: null }, data: { itemId: item.id } });
      if (linked.count === 1) {
        await recordGiveaway({
          itemId: item.id,
          orderId: sale.orderId,
          orderItemId: sale.orderItemId,
          quantity: sale.quantity,
          givenAt: sale.soldAt,
          showId,
          cancelled: false,
        });
      } else {
        sale = await find();
        continue;
      }
    }
    firstForBuyer = (await prisma.showSale.count({ where: { buyerId: sale.buyerId, sortedUnits: { gt: 0 } } })) === 0;
    // One unit per scan: each bag has its own copy of the label.
    const r = await sortOneUnit(sale.id, by);
    if (r.sorted) {
      box = r.box;
      done = true;
      break;
    }
    sale = await find();
  }
  if (!sale || !done) {
    const sorted = await prisma.showSale.findFirst({
      where: { showId, itemId: item.id, cancelledAt: null, sortedUnits: { gt: 0 } },
      orderBy: { sortedAt: "desc" },
      select: { buyerId: true },
    });
    const sortedBox = sorted
      ? ((await prisma.showBoxAssignment.findFirst({
          where: { buyerId: sorted.buyerId, releasedAt: null },
          orderBy: { seq: "desc" },
          include: { box: { select: { number: true } } },
        }))?.box.number ?? null)
      : null;
    return { status: "waiting", title, code: item.sku, sortedBox };
  }

  const buyer = await prisma.showBuyer.findUniqueOrThrow({
    where: { id: sale.buyerId },
    include: { boxes: { where: { releasedAt: null }, orderBy: { seq: "asc" }, include: { box: { select: { number: true } } } } },
  });
  const index = await prisma.showBuyer.count({ where: { showId, createdAt: { lt: buyer.createdAt } } });
  return {
    status: "sorted",
    box,
    boxes: buyer.boxes.map((a) => a.box.number),
    buyer: buyerLabel(buyer, index),
    buyerId: buyer.id,
    firstForBuyer,
    title,
    code: item.sku,
    giveaway: sale.saleType === "giveaway",
  };
}

// Packing mode: units the runner never sorted come off their bin, so that
// at least `target` of the sale's units are out of stock (never more than
// it sold). Under the show lock, so two scans at once can't miss one.
export async function sortShowUnitsUpTo(saleId: string, target: number, by: string | null): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const head = await tx.showSale.findUniqueOrThrow({ where: { id: saleId }, select: { showId: true } });
      await showLock(tx, head.showId);
      const sale = await tx.showSale.findUniqueOrThrow({ where: { id: saleId } });
      const units = Math.max(0, Math.min(target, sale.quantity) - sale.sortedUnits);
      if (sale.cancelledAt || units === 0) return;
      const box = await ensureBox(tx, sale.buyerId);
      const taken = sale.itemId
        ? await removeUnits(tx, { itemId: sale.itemId, units, kind: "pick", by, note: `Whatnot show box ${box ?? "?"} (at packing)` })
        : [];
      await tx.showSale.update({
        where: { id: saleId },
        data: {
          sortedUnits: { increment: units },
          sortedAt: new Date(),
          sortedBy: by,
          boxNumber: sale.boxNumber ?? box,
          fromBinCode: taken[0]?.binCode ?? sale.fromBinCode,
        },
      });
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
}

// sorted false = someone else got there first (or it was cancelled).

async function sortOneUnit(saleId: string, by: string | null): Promise<{ box: number | null; sorted: boolean }> {
  return await prisma.$transaction(
    async (tx) => {
      const head = await tx.showSale.findUniqueOrThrow({ where: { id: saleId }, select: { showId: true } });
      await showLock(tx, head.showId);
      const sale = await tx.showSale.findUniqueOrThrow({ where: { id: saleId } });
      const box = await ensureBox(tx, sale.buyerId);
      if (sale.cancelledAt || sale.sortedUnits >= sale.quantity) return { box, sorted: false };
      const taken = sale.itemId
        ? await removeUnits(tx, { itemId: sale.itemId, units: 1, kind: "pick", by, note: `Whatnot show box ${box ?? "?"}` })
        : [];
      await tx.showSale.update({
        where: { id: saleId },
        data: {
          sortedUnits: { increment: 1 },
          sortedAt: new Date(),
          sortedBy: by,
          boxNumber: box,
          fromBinCode: taken[0]?.binCode ?? sale.fromBinCode,
        },
      });
      return { box, sorted: true };
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
}

// "It's in the box" for a sale the app can't scan (made in the show, not
// by the app): the runner found it by its title.
export async function markSortedByHand(saleId: string, by: string | null): Promise<number | null> {
  const sale = await prisma.showSale.findUnique({ where: { id: saleId }, select: { itemId: true } });
  if (!sale) throw new WarehouseError("That sale isn't in the show anymore.", 404);
  if (sale.itemId) throw new WarehouseError("This one is in the app: scan its label instead.", 409);
  return (await sortSale(saleId, by)).box;
}
