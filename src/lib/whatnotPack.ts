import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { getItemLocations, placeInBin, WarehouseError } from "./warehouse/bins";
import { normalizeCode, showBoxNumber } from "./warehouse/codes";
import { pickUnit } from "./warehouse/picking";
import { STATION_ONLINE_MS } from "./warehouse/settings";
import { reprintStoredLabel, storeAndPrintLabel, WHATNOT_LABEL_BATCH } from "./warehouse/shippingLabels";
import { PDF_LABEL_HELPER_VERSION } from "./warehouse/types";
import {
  generateLabel,
  getShipment,
  listOrderItems,
  listShipmentItems,
  whatnotConfigured,
  WhatnotError,
  type WhatnotOrderItem,
  type WhatnotShipment,
} from "./whatnot";
import { buyerLabel, releaseBoxes, sortShowUnitsUpTo } from "./whatnotShow";

// Packing mode for a Whatnot show (Cristian, 2026-11-07), at the Whatnot
// station after the show: scan a show box's QR, the buyer's whole order
// comes up, every item is scanned into the shipping box (so nothing is
// missed or swapped), then the app asks Whatnot for the label and it
// prints at the station. Seal it, and the show box is free again.
//
// What goes in the box is what Whatnot put on the buyer's shipment(s): the
// show's lines (in the show box), plus anything else Whatnot bundled onto
// the same shipment, like a buy-it-now from the Whatnot shop (on a shelf;
// scanning it here counts as its pick).

export type PackLine = {
  orderItemId: string;
  orderId: string;
  title: string;
  code: string | null;
  photo: string | null;
  quantity: number;
  packed: number;
  byHand: boolean;
  // box = sold in this show (in the show box, or still in its bin if the
  // runner never sorted it); shelf = something else on the shipment.
  source: "box" | "shelf";
  // Where to grab it, when it isn't in the show box.
  where: string | null;
  // The app can't scan it (made in the show, not by the app): ticked by hand.
  unknown: boolean;
  saleType: string;
  cancelled: boolean;
  // Cancelled after it went in the show box: take it out, back to a bin.
  putBack: boolean;
  fromBin: string | null;
  saleId: string | null;
  itemId: string | null;
};

export type PackShipment = { id: string; pickup: boolean; status: string; labelPrinted: boolean };

export type PackView = {
  buyerId: string;
  showId: string;
  showTitle: string | null;
  buyer: string;
  boxes: number[];
  lines: PackLine[];
  shipments: PackShipment[];
  // Every line still being sent is in, and nothing cancelled is left in the box.
  complete: boolean;
  // Nothing left to ship at all (all cancelled).
  nothingToShip: boolean;
  warnings: string[];
  labelRequestedAt: string | null;
  labelPrintedAt: string | null;
  labelError: string | null;
  packedAt: string | null;
  // Labels kept for a reprint (the files themselves stay on the server).
  labelCount: number;
};

// Whatnot reads per buyer, kept a minute so each scan doesn't read the
// shipments again.
const shipmentCache = new Map<string, { at: number; shipments: WhatnotShipment[]; extras: ExtraLine[]; warnings: string[] }>();
const CACHE_MS = 60_000;

type ExtraLine = { line: WhatnotOrderItem; shipmentId: string };

// A shipment as it is now: Whatnot re-bundles and splits shipments, and
// the old one points at the one that took its items.
async function currentShipment(id: string): Promise<WhatnotShipment> {
  let shipment = await getShipment(id);
  for (let hop = 0; hop < 3 && shipment.replacement_shipment_id; hop++) {
    shipment = await getShipment(shipment.replacement_shipment_id);
  }
  return shipment;
}

async function readShipments(buyerId: string, shipmentIds: string[], ownLines: Set<string>, fresh: boolean) {
  const cached = shipmentCache.get(buyerId);
  // "Fresh" still reuses a read from the last few seconds, so reloading
  // can't eat Whatnot's rate limit (shared with the stock sync).
  if (cached && Date.now() - cached.at < (fresh ? 10_000 : CACHE_MS)) return cached;
  const warnings: string[] = [];
  const shipments = new Map<string, WhatnotShipment>();
  const extras: ExtraLine[] = [];
  if (!whatnotConfigured()) {
    warnings.push("Whatnot isn't connected, so only the show's own sales are listed.");
  } else {
    try {
      for (const id of shipmentIds) {
        const s = await currentShipment(id);
        shipments.set(s.id, s);
      }
      const orderItems = new Map<string, WhatnotOrderItem[]>();
      for (const s of shipments.values()) {
        for (const si of await listShipmentItems(s.id)) {
          if (!si.order_item_id || ownLines.has(si.order_item_id) || !si.order_id) continue;
          if (!orderItems.has(si.order_id)) orderItems.set(si.order_id, await listOrderItems(si.order_id));
          const line = orderItems.get(si.order_id)!.find((l) => l.id === si.order_item_id);
          if (line && line.quantity > 0) extras.push({ line, shipmentId: s.id });
        }
      }
    } catch (e) {
      warnings.push(`Couldn't read the shipment from Whatnot (${e instanceof Error ? e.message : String(e)}), so only the show's own sales are listed.`);
    }
  }
  const out = { at: Date.now(), shipments: [...shipments.values()], extras, warnings };
  if (shipmentCache.size > 200) shipmentCache.clear();
  shipmentCache.set(buyerId, out);
  return out;
}

// The app's item for a line Whatnot bundled on, the same way order sync
// matches one.
async function itemForExtra(line: WhatnotOrderItem) {
  const ids = [
    ...(line.variant_id ? [{ whatnotVariantId: line.variant_id }] : []),
    ...(line.product_id ? [{ whatnotProductId: line.product_id }] : []),
  ];
  const select = { id: true, sku: true, finalTitle: true, aiTitle: true, photoUrls: true, shelfLocation: true } as const;
  if (ids.length) {
    const byId = await prisma.item.findFirst({ where: { OR: ids }, select });
    if (byId) return byId;
  }
  const sku = line.purchased_item?.sku?.trim() || line.variant_external_id || line.product_external_id;
  if (!sku) return null;
  return await prisma.item.findFirst({ where: { sku, OR: [{ whatnotPublishedAt: { not: null } }, { whatnotGiveaway: true }] }, select });
}

export async function packView(buyerId: string, opts?: { fresh?: boolean }): Promise<PackView> {
  const buyer = await prisma.showBuyer.findUnique({
    where: { id: buyerId },
    include: {
      boxes: { where: { releasedAt: null }, orderBy: { seq: "asc" }, include: { box: { select: { number: true } } } },
      sales: {
        orderBy: { soldAt: "asc" },
        include: { item: { select: { id: true, sku: true, finalTitle: true, aiTitle: true, photoUrls: true, shelfLocation: true } } },
      },
      packScans: true,
    },
  });
  if (!buyer) throw new WarehouseError("That buyer isn't in a show anymore.", 404);
  const index = await prisma.showBuyer.count({ where: { showId: buyer.showId, createdAt: { lt: buyer.createdAt } } });
  const scans = new Map(buyer.packScans.map((p) => [p.orderItemId, p]));
  const own = new Set(buyer.sales.map((s) => s.orderItemId));
  const shipmentIds = [...new Set(buyer.sales.filter((s) => !s.cancelledAt && s.shipmentId).map((s) => s.shipmentId!))];
  const read = await readShipments(buyer.id, shipmentIds, own, opts?.fresh === true);

  // Sold-in-show lines the runner never put in the box are still in their
  // bin: say where.
  const unsortedIds = buyer.sales.filter((s) => s.item && s.sortedUnits < s.quantity).map((s) => s.item!);
  const extraItems = await Promise.all(read.extras.map((e) => itemForExtra(e.line)));
  const locations = await getItemLocations([...unsortedIds, ...extraItems.filter((i): i is NonNullable<typeof i> => i != null)]);
  const whereText = (itemId: string) => {
    const loc = locations.get(itemId);
    if (!loc) return null;
    if (loc.bins.length) return loc.bins.map((b) => (b.shelfLabel ? `${b.binCode} on ${b.shelfLabel}` : b.binCode)).join(", ");
    return loc.legacyShelf ? `Shelf ${loc.legacyShelf}` : null;
  };

  const lines: PackLine[] = buyer.sales.map((s) => {
    const scan = scans.get(s.orderItemId);
    const cancelled = s.cancelledAt != null;
    return {
      orderItemId: s.orderItemId,
      orderId: s.orderId,
      title: s.item?.finalTitle ?? s.item?.aiTitle ?? s.title,
      code: s.item?.sku ?? null,
      photo: s.item?.photoUrls[0] ?? null,
      quantity: s.quantity,
      packed: Math.min(scan?.units ?? 0, s.quantity),
      byHand: scan?.byHand ?? false,
      source: "box",
      where: s.item && s.sortedUnits < s.quantity ? whereText(s.item.id) : null,
      unknown: s.itemId == null,
      saleType: s.saleType,
      cancelled,
      putBack: cancelled && s.sortedUnits > 0 && s.returnedAt == null && s.itemId != null,
      fromBin: s.fromBinCode,
      saleId: s.id,
      itemId: s.itemId,
    };
  });
  read.extras.forEach((e, i) => {
    const item = extraItems[i];
    const scan = scans.get(e.line.id);
    lines.push({
      orderItemId: e.line.id,
      orderId: e.line.order_id,
      title: item?.finalTitle ?? item?.aiTitle ?? e.line.purchased_item?.title ?? "Whatnot item",
      code: item?.sku ?? null,
      photo: item?.photoUrls[0] ?? null,
      quantity: e.line.quantity,
      packed: Math.min(scan?.units ?? 0, e.line.quantity),
      byHand: scan?.byHand ?? false,
      source: "shelf",
      where: item ? whereText(item.id) : null,
      unknown: item == null,
      saleType: "buy_it_now",
      cancelled: false,
      putBack: false,
      fromBin: null,
      saleId: null,
      itemId: item?.id ?? null,
    });
  });

  const live = lines.filter((l) => !l.cancelled);
  const printed = await prisma.shippingLabel.findMany({
    where: { batchId: `${WHATNOT_LABEL_BATCH}${buyer.id}` },
    select: { id: true, orderIds: true },
    orderBy: { createdAt: "asc" },
  });
  const printedShipments = new Set(printed.flatMap((p) => p.orderIds));
  return {
    buyerId: buyer.id,
    showId: buyer.showId,
    showTitle: buyer.showTitle,
    buyer: buyerLabel(buyer, index),
    boxes: buyer.boxes.map((a) => a.box.number),
    lines,
    shipments: read.shipments.map((s) => ({
      id: s.id,
      pickup: s.fulfillment_method === "pickup",
      status: s.status,
      labelPrinted: printedShipments.has(shipmentKey(s.id)),
    })),
    complete: live.length > 0 && live.every((l) => l.packed >= l.quantity) && !lines.some((l) => l.putBack),
    nothingToShip: live.length === 0 && !lines.some((l) => l.putBack),
    warnings: read.warnings,
    labelRequestedAt: buyer.labelRequestedAt?.toISOString() ?? null,
    labelPrintedAt: buyer.labelPrintedAt?.toISOString() ?? null,
    labelError: buyer.labelError,
    packedAt: buyer.packedAt?.toISOString() ?? null,
    labelCount: printed.length,
  };
}

const shipmentKey = (id: string) => `whatnot-shipment:${id}`;

// The buyer whose show box this is (scanned in packing mode).
export async function buyerForBox(rawCode: string): Promise<string> {
  const n = showBoxNumber(rawCode);
  if (n == null) throw new WarehouseError("That's not a show box. Scan the QR on a WHATNOT SHOW BOX label.");
  const a = await prisma.showBoxAssignment.findFirst({
    where: { box: { number: n }, releasedAt: null },
    orderBy: { assignedAt: "desc" },
    select: { buyerId: true },
  });
  if (!a) throw new WarehouseError(`Show box ${n} isn't anyone's right now. It's empty, or already packed.`, 404);
  return a.buyerId;
}

export type PackScanResult = { ok: true; title: string; packed: number; quantity: number; complete: boolean } | { ok: false; reason: string };

// One item scanned into the shipping box.
export async function packScan(buyerId: string, rawCode: string, by: string | null): Promise<PackScanResult> {
  const code = normalizeCode(rawCode);
  const view = await packView(buyerId);
  if (view.packedAt) return { ok: false, reason: "This order is already packed." };
  const item = await prisma.item.findUnique({ where: { sku: code }, select: { id: true, finalTitle: true, aiTitle: true } });
  if (!item) return { ok: false, reason: `Nothing in the app has the code ${code}. Scan the ES label on the bag.` };
  const name = item.finalTitle ?? item.aiTitle ?? code;
  const line = view.lines.find((l) => l.itemId === item.id && !l.cancelled && l.packed < l.quantity);
  if (!line) {
    const cancelled = view.lines.find((l) => l.itemId === item.id && l.cancelled);
    if (cancelled) {
      return { ok: false, reason: `That one was cancelled: don't pack it. Put it back in ${cancelled.fromBin ?? "a Whatnot bin"}.` };
    }
    if (view.lines.some((l) => l.itemId === item.id)) return { ok: false, reason: `All of "${name}" for this buyer is already in.` };
    // Someone else's in this show?
    const other = await prisma.showSale.findFirst({
      where: { showId: view.showId, itemId: item.id, cancelledAt: null, buyerId: { not: buyerId } },
      include: { buyer: { include: { boxes: { where: { releasedAt: null }, include: { box: { select: { number: true } } } } } } },
    });
    if (other) {
      const boxes = other.buyer.boxes.map((b) => b.box.number);
      return {
        ok: false,
        reason: `Wrong box: that's ${other.buyer.buyerName ? `@${other.buyer.buyerName}'s` : "another buyer's"}${boxes.length ? `, it goes in show box ${boxes.join(" or ")}` : ""}.`,
      };
    }
    return { ok: false, reason: `"${name}" isn't part of this order.` };
  }

  // The pack count first, claimed so it never passes the line's quantity
  // (two bags scanned at once each get their own unit or a clear "all in").
  const key = { buyerId_orderItemId: { buyerId, orderItemId: line.orderItemId } };
  await prisma.showPackScan.upsert({ where: key, create: { buyerId, orderItemId: line.orderItemId, units: 0, scannedBy: by }, update: {} });
  const claimed = await prisma.showPackScan.updateMany({
    where: { buyerId, orderItemId: line.orderItemId, units: { lt: line.quantity } },
    data: { units: { increment: 1 }, scannedBy: by },
  });
  if (claimed.count === 0) return { ok: false, reason: `All of "${name}" for this buyer is already in.` };
  const target = (await prisma.showPackScan.findUniqueOrThrow({ where: key, select: { units: true } })).units;
  // Then out of stock up to that count if it wasn't already: a show line
  // the runner never sorted comes off its bin, a bundled-on shop order
  // gets its pick.
  if (line.saleId) {
    await sortShowUnitsUpTo(line.saleId, target, by);
  } else {
    const picks = await prisma.orderPick.count({ where: { channel: "whatnot", lineItemId: line.orderItemId } });
    if (picks < target) {
      const r = await pickUnit({ channel: "whatnot", orderId: line.orderId, lineItemId: line.orderItemId, scannedCode: code }, by);
      if (!r.ok && r.code !== "already_picked") {
        await prisma.showPackScan.updateMany({ where: { buyerId, orderItemId: line.orderItemId, units: { gt: 0 } }, data: { units: { decrement: 1 } } });
        return { ok: false, reason: r.reason };
      }
    }
  }
  const after = await packView(buyerId);
  const now = after.lines.find((l) => l.orderItemId === line.orderItemId);
  return { ok: true, title: line.title, packed: now?.packed ?? line.packed + 1, quantity: line.quantity, complete: after.complete };
}

// "It's in the box" for a line the app can't scan.
export async function packByHand(buyerId: string, orderItemId: string, by: string | null): Promise<void> {
  const view = await packView(buyerId);
  const line = view.lines.find((l) => l.orderItemId === orderItemId);
  if (!line) throw new WarehouseError("That line isn't on this order.", 404);
  if (!line.unknown) throw new WarehouseError("This one is in the app: scan its label.", 409);
  if (line.cancelled) throw new WarehouseError("That one was cancelled: don't pack it.", 409);
  await prisma.showPackScan.upsert({
    where: { buyerId_orderItemId: { buyerId, orderItemId } },
    create: { buyerId, orderItemId, units: line.quantity, byHand: true, scannedBy: by },
    update: { units: line.quantity, byHand: true, scannedBy: by },
  });
}

// A cancelled unit that was already in the show box goes back in a bin.
export async function putBack(buyerId: string, saleId: string, binCode: string, by: string | null): Promise<string> {
  const sale = await prisma.showSale.findUnique({ where: { id: saleId } });
  if (!sale || sale.buyerId !== buyerId) throw new WarehouseError("That sale isn't on this order.", 404);
  if (!sale.cancelledAt) throw new WarehouseError("That sale wasn't cancelled: pack it.", 409);
  if (sale.returnedAt) return sale.returnedTo ?? "";
  if (!sale.itemId || sale.sortedUnits < 1) {
    await prisma.showSale.update({ where: { id: saleId }, data: { returnedAt: new Date() } });
    return "";
  }
  const code = normalizeCode(binCode);
  await prisma.$transaction(
    async (tx) => {
      // Claimed first: a second "Put back" (Enter and a tap, a double scan)
      // waits on this row, then finds it done, so the units go in once.
      const claim = await tx.showSale.updateMany({ where: { id: saleId, returnedAt: null }, data: { returnedAt: new Date(), returnedTo: code } });
      if (claim.count === 0) return;
      const fresh = await tx.showSale.findUniqueOrThrow({ where: { id: saleId } });
      await placeInBin(tx, { itemId: sale.itemId!, binCode: code, units: fresh.sortedUnits, by, note: "Cancelled Whatnot show sale, back from the show box" });
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  return code;
}

// Nothing left to ship (everything cancelled and put back): the boxes are free.
export async function closeEmpty(buyerId: string, by: string | null): Promise<void> {
  const view = await packView(buyerId, { fresh: true });
  if (!view.nothingToShip) throw new WarehouseError("There's still something to ship on this order.", 409);
  await prisma.$transaction(async (tx) => {
    await tx.showBuyer.update({ where: { id: buyerId }, data: { packedAt: new Date(), packedBy: by } });
    await releaseBoxes(tx, buyerId);
  });
}

// ---------------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------------

async function checkStation(stationId: string) {
  const s = await prisma.station.findUnique({
    where: { id: stationId },
    select: { id: true, name: true, printerName: true, helperSeenAt: true, helperVersion: true },
  });
  if (!s) throw new WarehouseError("That station doesn't exist anymore. Scan into the station again.", 404);
  if (!s.printerName) {
    throw new WarehouseError(`${s.name} has no 4x6 printer picked for its print helper. Pick one on its station page first.`, 409);
  }
  if (!s.helperVersion || s.helperVersion < PDF_LABEL_HELPER_VERSION) {
    // Whatnot's labels can be PDFs, which only newer helpers print. Ask
    // this one to update itself (it does within a minute).
    await prisma.station.update({ where: { id: s.id }, data: { helperUpdateAt: new Date() } });
    throw new WarehouseError(`${s.name}'s print helper is updating so it can print Whatnot labels. Try again in a minute.`, 409);
  }
  if (!s.helperSeenAt || Date.now() - s.helperSeenAt.getTime() > STATION_ONLINE_MS) {
    throw new WarehouseError(`${s.name}'s print helper isn't running. Check the station PC.`, 409);
  }
  return s;
}

// A label file from Whatnot's label provider: https only, PDF or PNG, a
// few MB at most. The address is on it, so it's only kept like the eBay
// labels (shippingLabels.ts).
const MAX_LABEL_BYTES = 5_000_000;

async function downloadLabel(url: string): Promise<Uint8Array> {
  // https all the way: redirects are followed by hand (2 at most), each
  // one checked again, so a link can't bounce to plain http or anywhere
  // odd (security review, 2026-11-07).
  let target = new URL(url);
  let res: Response | null = null;
  for (let hop = 0; hop < 3; hop++) {
    if (target.protocol !== "https:") throw new Error("Whatnot's label link isn't https.");
    res = await fetch(target, { signal: AbortSignal.timeout(20_000), redirect: "manual" });
    if (res.status < 300 || res.status >= 400) break;
    const next = res.headers.get("location");
    if (!next || hop === 2) throw new Error("The label link redirected too many times.");
    target = new URL(next, target);
    res = null;
  }
  if (!res || !res.ok || !res.body) throw new Error(`Couldn't download the label (${res?.status ?? "no answer"}).`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_LABEL_BYTES) throw new Error("The label file is too big.");
  // Read with a cap, so a missing or wrong length can't fill memory.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_LABEL_BYTES) {
      await reader.cancel();
      throw new Error("The label file is too big.");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  const head = Buffer.from(buf.subarray(0, 4)).toString("latin1");
  const png = buf[0] === 0x89 && head.slice(1) === "PNG";
  if (head !== "%PDF" && !png) throw new Error("Whatnot's label isn't a PDF or PNG.");
  return buf;
}

export type LabelStatus = { status: "printed" | "waiting" | "error"; message: string };

// Packed and checked: asks Whatnot for each shipment's label (or prints
// the ones it already has), to print at this station.
export async function requestLabel(buyerId: string, stationId: string, by: string | null): Promise<LabelStatus> {
  if (!whatnotConfigured()) throw new WarehouseError("Whatnot isn't connected, so the label can't be printed from here. Print it in Whatnot.", 409);
  const view = await packView(buyerId, { fresh: true });
  if (view.packedAt) throw new WarehouseError("This order is already packed.", 409);
  if (!view.complete) throw new WarehouseError("Scan everything into the box first.", 409);
  if (view.shipments.length === 0) throw new WarehouseError("Whatnot has no shipment for this order yet. Try again in a minute.", 409);
  await checkStation(stationId);
  const errors: string[] = [];
  for (const s of view.shipments) {
    if (s.pickup || s.labelPrinted || s.status !== "created") continue;
    try {
      await generateLabel(s.id);
    } catch (e) {
      // Already made (two clicks) is fine: the check below picks it up.
      if (!(e instanceof WhatnotError && e.status === 409 && /already|exists/i.test(e.message))) {
        errors.push(e instanceof WhatnotError && e.status === 409 ? `Whatnot won't make this label: ${e.message}` : e instanceof Error ? e.message : String(e));
      }
    }
  }
  await prisma.showBuyer.update({
    where: { id: buyerId },
    data: {
      labelRequestedAt: new Date(),
      labelRequestedBy: by,
      labelStationId: stationId,
      labelShipmentIds: view.shipments.map((s) => s.id),
      labelError: errors.length ? errors.join(" ").slice(0, 500) : null,
    },
  });
  if (errors.length) return { status: "error", message: errors.join(" ") };
  return await checkLabels(buyerId);
}

// Prints every requested label Whatnot has made by now; once all are out,
// the order is packed and its show boxes are free. Called by the packing
// screen while it waits, and by the label webhook.
export async function checkLabels(buyerId: string): Promise<LabelStatus> {
  const doneKeys = async (tx: Prisma.TransactionClient | typeof prisma) =>
    new Set(
      (await tx.shippingLabel.findMany({ where: { batchId: `${WHATNOT_LABEL_BATCH}${buyerId}` }, select: { orderIds: true } })).flatMap((l) => l.orderIds)
    );
  const buyer = await prisma.showBuyer.findUniqueOrThrow({ where: { id: buyerId } });
  if (buyer.labelPrintedAt) return { status: "printed", message: "Label printed." };
  if (!buyer.labelRequestedAt || !buyer.labelStationId) return { status: "waiting", message: "No label asked for yet." };
  const stationId = buyer.labelStationId;

  // Whatnot and the label files first, outside any transaction (they can
  // take seconds).
  const before = await doneKeys(prisma);
  const ready: { id: string; pickup: boolean; file: Uint8Array | null; tracking: string | null; carrier: string | null }[] = [];
  let waiting = 0;
  for (const id of buyer.labelShipmentIds) {
    if (before.has(shipmentKey(id))) continue;
    const s = await getShipment(id);
    const pickup = s.fulfillment_method === "pickup";
    // Pickup: the pickup slip if Whatnot has one, else nothing to print.
    const url = pickup ? s.documents?.bundled_url : (s.documents?.label_url ?? null);
    if (!url) {
      if (pickup) {
        ready.push({ id, pickup, file: null, tracking: null, carrier: null });
        continue;
      }
      if (!s.documents) {
        return {
          status: "error",
          message:
            "Whatnot isn't sharing label files with the app. The API token needs the read:customers permission (make a new token in Whatnot's developer dashboard and put it in Vercel). Print this one in Whatnot.",
        };
      }
      waiting++;
      continue;
    }
    ready.push({ id, pickup, file: await downloadLabel(url), tracking: s.tracking?.tracking_code ?? null, carrier: s.tracking?.carrier ?? null });
  }

  // Then print and record, one at a time per buyer, so the webhook and the
  // screen can't both print the same label.
  return await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`whatnot_label:${buyerId}`}))`;
      const fresh = await tx.showBuyer.findUniqueOrThrow({ where: { id: buyerId } });
      if (fresh.labelPrintedAt) return { status: "printed" as const, message: "Label printed." };
      const done = await doneKeys(tx);
      for (const r of ready) {
        if (done.has(shipmentKey(r.id))) continue;
        if (r.file) {
          await storeAndPrintLabel({
            file: r.file,
            batchId: `${WHATNOT_LABEL_BATCH}${buyerId}`,
            orderIds: [shipmentKey(r.id)],
            trackingNumber: r.tracking,
            carrier: r.carrier,
            stationId,
            by: fresh.labelRequestedBy,
            code: `Whatnot ${r.pickup ? "pickup" : "label"} ${fresh.buyerName ? `@${fresh.buyerName}` : r.id.slice(-6)}`,
          });
        }
        done.add(shipmentKey(r.id));
      }
      if (waiting > 0) return { status: "waiting" as const, message: "Waiting for Whatnot to make the label…" };
      await tx.showBuyer.update({
        where: { id: buyerId },
        data: { labelPrintedAt: new Date(), packedAt: new Date(), packedBy: fresh.labelRequestedBy, labelError: null },
      });
      await releaseBoxes(tx, buyerId);
      return { status: "printed" as const, message: ready.some((r) => r.file) ? "Label printed. Seal the box." : "Done. Set it aside for pickup." };
    },
    { timeout: 30_000, maxWait: 20_000 }
  );
}

// The label webhook: whichever buyer was waiting on this shipment.
export async function labelGenerated(shipmentId: string): Promise<void> {
  const buyers = await prisma.showBuyer.findMany({
    where: { labelShipmentIds: { has: shipmentId }, labelPrintedAt: null, labelRequestedAt: { not: null } },
    select: { id: true },
  });
  for (const b of buyers) await checkLabels(b.id).catch((e) => console.error(`[whatnot pack] label for ${b.id}`, e));
}

export async function reprintLabels(buyerId: string, stationId: string, by: string | null): Promise<number> {
  await checkStation(stationId);
  const labels = await prisma.shippingLabel.findMany({ where: { batchId: `${WHATNOT_LABEL_BATCH}${buyerId}` }, select: { id: true } });
  let n = 0;
  for (const l of labels) if (await reprintStoredLabel(l.id, stationId, by, "Whatnot label (reprint)")) n++;
  if (n === 0) throw new WarehouseError("The label isn't kept anymore (3 days after printing). Reprint it in Whatnot.", 404);
  return n;
}

// ---------------------------------------------------------------------------
// The show's list on the packing screen
// ---------------------------------------------------------------------------

export type PackListRow = {
  buyerId: string;
  buyer: string;
  boxes: number[];
  units: number;
  // Sold units the runner never put in a box (still in a bin).
  unsorted: number;
  cancelled: number;
  status: "packed" | "label" | "to_pack";
};

export async function packList(showId: string): Promise<PackListRow[]> {
  const buyers = await prisma.showBuyer.findMany({
    where: { showId },
    orderBy: { createdAt: "asc" },
    include: {
      boxes: { where: { releasedAt: null }, orderBy: { seq: "asc" }, include: { box: { select: { number: true } } } },
      sales: { select: { quantity: true, sortedUnits: true, cancelledAt: true } },
    },
  });
  return buyers.map((b, i) => {
    const live = b.sales.filter((s) => !s.cancelledAt);
    return {
      buyerId: b.id,
      buyer: buyerLabel(b, i),
      boxes: b.boxes.map((a) => a.box.number),
      units: live.reduce((n, s) => n + s.quantity, 0),
      unsorted: live.reduce((n, s) => n + Math.max(0, s.quantity - s.sortedUnits), 0),
      cancelled: b.sales.length - live.length,
      status: b.packedAt ? "packed" : b.labelRequestedAt ? "label" : "to_pack",
    };
  });
}

// Shows with buyers, newest first, for the packing screen's picker.
export async function recentShows(): Promise<{ showId: string; title: string | null; buyers: number; toPack: number; lastSale: string }[]> {
  const rows = await prisma.showBuyer.groupBy({
    by: ["showId"],
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take: 10,
  });
  const out = [];
  for (const r of rows) {
    const [first, toPack] = await Promise.all([
      prisma.showBuyer.findFirst({ where: { showId: r.showId, showTitle: { not: null } }, select: { showTitle: true } }),
      prisma.showBuyer.count({ where: { showId: r.showId, packedAt: null } }),
    ]);
    out.push({ showId: r.showId, title: first?.showTitle ?? null, buyers: r._count._all, toPack, lastSale: r._max.createdAt!.toISOString() });
  }
  return out;
}
