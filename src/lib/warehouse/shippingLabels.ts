import type { Prisma } from "@/generated/prisma/client";
import { getRecentShipments, type EbayShipment } from "../ebay";
import { prisma } from "../prisma";
import { WarehouseError } from "./bins";
import { packingStation } from "./packingSlip";

// Shipping labels bought on eBay, printed by scanning the packing slip
// (Cristian, 2026-10-19). His flow:
//   1. Pick: each order's packing slip prints. It's a picking slip for the
//      warehouse, clipped to the box's corner, never sent to the buyer.
//   2. Pack, weigh, enter weight and size in eBay.
//   3. Buy every label in one go (so they all go on one scan form) and
//      download eBay's PDF.
//   4. Upload it on Pick orders. The browser turns each page into an image
//      and reads its text and barcodes; here each page is matched to its
//      order by the tracking number on it.
//   5. Scan a box's slip: its label prints at the packing station, and the
//      order counts as done here.
// eBay's API can't hand back the label files themselves, hence the upload.
// Server only.

// Labels bought this long ago are still matched.
const SHIPMENT_DAYS = 5;
// A label's image is the buyer's address, so it doesn't stay: gone this
// long after it printed (time for a reprint if one jams), or this long
// after upload if it never printed. Rows go entirely after a month.
const KEEP_PRINTED_MS = 3 * 24 * 60 * 60 * 1000;
const KEEP_UNPRINTED_MS = 10 * 24 * 60 * 60 * 1000;
const KEEP_ROW_MS = 30 * 24 * 60 * 60 * 1000;
// What the list on Pick orders shows.
const LIST_DAYS = 7;

const compact = (s: string) => s.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
const ORDER_ID_RE = /^\d{2}-\d{5}-\d{5}$/;

export function isEbayOrderNumber(code: string): boolean {
  return ORDER_ID_RE.test(code.trim());
}

// ---------------------------------------------------------------------------
// Matching pages to orders
// ---------------------------------------------------------------------------

export type PageRead = { text: string; barcodes: string[] };
export type PageMatch = {
  trackingNumber: string | null;
  carrier: string | null;
  orderIds: string[];
  // "tracking": the page shows a tracking number eBay has for the order.
  // "address": no tracking number found, but the ship-to name and ZIP
  // match exactly one order. null: no match, assign it by hand.
  matchedBy: "tracking" | "address" | null;
};

export async function matchPages(pages: PageRead[]): Promise<PageMatch[]> {
  const shipments = await getRecentShipments(SHIPMENT_DAYS);
  // Combined shipping: one tracking number on several orders.
  const byTracking = new Map<string, EbayShipment[]>();
  for (const s of shipments) {
    for (const t of s.trackingNumbers) byTracking.set(t, [...(byTracking.get(t) ?? []), s]);
  }
  // Longest first, so a short number can't match inside a long one.
  const trackingNumbers = [...byTracking.keys()].filter((t) => t.length >= 10).sort((a, b) => b.length - a.length);

  return pages.map((page) => {
    const haystacks = [compact(page.text), ...page.barcodes.map(compact)];
    const tracking = trackingNumbers.find((t) => haystacks.some((h) => h.includes(t)));
    if (tracking) {
      const list = byTracking.get(tracking)!;
      return { trackingNumber: tracking, carrier: list[0].carrier, orderIds: [...new Set(list.map((s) => s.orderId))], matchedBy: "tracking" };
    }
    // Fallback: the ship-to block. Name and ZIP must both be on the page,
    // and only one order may fit.
    const text = page.text.toUpperCase().replace(/\s+/g, " ");
    const byAddress = shipments.filter(
      (s) => s.shipToName && s.shipToZip && text.includes(s.shipToName.toUpperCase().replace(/\s+/g, " ")) && text.includes(s.shipToZip)
    );
    const tracked = new Set(byAddress.flatMap((s) => s.trackingNumbers));
    if (byAddress.length > 0 && tracked.size === 1) {
      return { trackingNumber: [...tracked][0], carrier: byAddress[0].carrier, orderIds: byAddress.map((s) => s.orderId), matchedBy: "address" };
    }
    return { trackingNumber: null, carrier: null, orderIds: [], matchedBy: null };
  });
}

// ---------------------------------------------------------------------------
// Saving uploaded pages
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 3_000_000;

export async function saveLabelPage(input: {
  batchId: string;
  page: number;
  trackingNumber: string | null;
  carrier: string | null;
  orderIds: string[];
  imageBase64: string;
  widthIn: number;
  heightIn: number;
  by: string | null;
}): Promise<{ id: string; replaced: boolean }> {
  const image = Buffer.from(input.imageBase64.replace(/^data:image\/png;base64,/, ""), "base64");
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES) throw new WarehouseError("That page image is empty or too big.");
  if (image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new WarehouseError("That page isn't a PNG image.");
  const orderIds = input.orderIds.filter((id) => ORDER_ID_RE.test(id));
  const data = {
    batchId: input.batchId,
    page: input.page,
    trackingNumber: input.trackingNumber ? compact(input.trackingNumber) : null,
    carrier: input.carrier,
    orderIds,
    image: new Uint8Array(image),
    widthIn: input.widthIn,
    heightIn: input.heightIn,
    uploadedBy: input.by,
  };
  // The same PDF uploaded twice replaces the label, keeping whether it
  // already printed.
  const existing = data.trackingNumber
    ? await prisma.shippingLabel.findFirst({ where: { trackingNumber: data.trackingNumber }, orderBy: { createdAt: "desc" } })
    : null;
  if (existing) {
    await prisma.shippingLabel.update({ where: { id: existing.id }, data });
    return { id: existing.id, replaced: true };
  }
  const row = await prisma.shippingLabel.create({ data });
  return { id: row.id, replaced: false };
}

// ---------------------------------------------------------------------------
// The list on Pick orders
// ---------------------------------------------------------------------------

export type LabelRow = {
  id: string;
  batchId: string;
  page: number;
  trackingNumber: string | null;
  carrier: string | null;
  orderIds: string[];
  hasImage: boolean;
  // Not a 4x6 page (e.g. eBay's letter-size layout): it'd print tiny.
  notFourBySix: boolean;
  createdAt: string;
  printedAt: string | null;
  printedBy: string | null;
  printCount: number;
};

async function cleanUp(): Promise<void> {
  const now = Date.now();
  await prisma.shippingLabel.updateMany({
    where: {
      image: { not: null },
      OR: [{ printedAt: { lt: new Date(now - KEEP_PRINTED_MS) } }, { createdAt: { lt: new Date(now - KEEP_UNPRINTED_MS) } }],
    },
    data: { image: null },
  });
  await prisma.shippingLabel.deleteMany({ where: { createdAt: { lt: new Date(now - KEEP_ROW_MS) } } });
}

const ROW_SELECT = {
  id: true,
  batchId: true,
  page: true,
  trackingNumber: true,
  carrier: true,
  orderIds: true,
  widthIn: true,
  heightIn: true,
  createdAt: true,
  printedAt: true,
  printedBy: true,
  printCount: true,
} as const;

type RowData = Prisma.ShippingLabelGetPayload<{ select: typeof ROW_SELECT }>;

function toRow(l: RowData, hasImage: boolean): LabelRow {
  const ratio = l.heightIn > 0 ? l.widthIn / l.heightIn : 0;
  return {
    id: l.id,
    batchId: l.batchId,
    page: l.page,
    trackingNumber: l.trackingNumber,
    carrier: l.carrier,
    orderIds: l.orderIds,
    hasImage,
    // 4x6 either way round, give or take.
    notFourBySix: Math.abs(Math.min(ratio, 1 / ratio) - 4 / 6) > 0.05 || Math.max(l.widthIn, l.heightIn) > 6.6,
    createdAt: l.createdAt.toISOString(),
    printedAt: l.printedAt?.toISOString() ?? null,
    printedBy: l.printedBy,
    printCount: l.printCount,
  };
}

export async function listLabels(): Promise<LabelRow[]> {
  await cleanUp().catch((e) => console.error("[shippingLabels] cleanup failed", e));
  const since = new Date(Date.now() - LIST_DAYS * 24 * 60 * 60 * 1000);
  const [rows, withImage] = await Promise.all([
    prisma.shippingLabel.findMany({ where: { createdAt: { gte: since } }, select: ROW_SELECT, orderBy: [{ createdAt: "desc" }, { page: "asc" }] }),
    prisma.shippingLabel.findMany({ where: { createdAt: { gte: since }, image: { not: null } }, select: { id: true } }),
  ]);
  const has = new Set(withImage.map((r) => r.id));
  return rows.map((r) => toRow(r, has.has(r.id)));
}

// ---------------------------------------------------------------------------
// Scanning a packing slip
// ---------------------------------------------------------------------------

export type LabelPrintResult =
  // Sent to the packing station. others: more orders on the same label
  // (combined shipping), so they go in the same box.
  | { status: "queued"; station: string; online: boolean; orderId: string; others: string[]; reprint: boolean; labelId: string }
  // No packing station set up: the page prints it itself.
  | { status: "print_here"; html: string; orderId: string; others: string[]; reprint: boolean; labelId: string }
  // Printed before. Scan again with force (the Reprint button) to print it again.
  | { status: "already"; orderId: string; printedAt: string; printedBy: string | null; labelId: string }
  | { status: "not_found" | "image_gone"; orderId: string };

function labelHtml(labelId: string): string {
  // The image loads from the app (the station is signed in), so the queued
  // job itself holds no address. The iframe's load waits for the image.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: 4in 6in; margin: 0; }
html, body { margin: 0; padding: 0; width: 4in; height: 6in; }
img { display: block; width: 4in; height: 6in; object-fit: contain; }
</style></head><body><img src="/api/ship/labels/${labelId}/image" alt=""></body></html>`;
}

export async function printLabelForOrder(input: {
  orderId: string;
  by: string | null;
  // The Reprint button: print it again even though it already printed.
  force: boolean;
  // Unmatched label to give this order first (Assign on Pick orders).
  assignLabelId?: string | null;
}): Promise<LabelPrintResult> {
  const orderId = input.orderId.trim();
  if (input.assignLabelId) {
    const target = await prisma.shippingLabel.findUnique({ where: { id: input.assignLabelId }, select: { id: true, orderIds: true } });
    if (!target) throw new WarehouseError("That label is gone. Upload the PDF again.", 404);
    if (!target.orderIds.includes(orderId)) {
      await prisma.shippingLabel.update({ where: { id: target.id }, data: { orderIds: [...target.orderIds, orderId] } });
    }
  }
  const label = await prisma.shippingLabel.findFirst({
    where: { orderIds: { has: orderId } },
    orderBy: { createdAt: "desc" },
    select: { ...ROW_SELECT },
  });
  if (!label) return { status: "not_found", orderId };
  if (label.printedAt && !input.force) {
    return { status: "already", orderId, printedAt: label.printedAt.toISOString(), printedBy: label.printedBy, labelId: label.id };
  }
  const hasImage = (await prisma.shippingLabel.count({ where: { id: label.id, image: { not: null } } })) > 0;
  if (!hasImage) return { status: "image_gone", orderId };

  const others = label.orderIds.filter((id) => id !== orderId);
  const reprint = label.printedAt != null;
  const station = await packingStation();
  await prisma.shippingLabel.update({
    where: { id: label.id },
    data: { printedAt: label.printedAt ?? new Date(), printedBy: label.printedBy ?? input.by, printCount: { increment: 1 } },
  });
  if (!station) return { status: "print_here", html: labelHtml(label.id), orderId, others, reprint, labelId: label.id };
  await prisma.printJob.create({
    data: {
      stationId: station.id,
      kind: "shipping_label",
      payload: { code: `Label ${orderId}`, html: labelHtml(label.id) } as Prisma.InputJsonValue,
      copies: 1,
      createdBy: input.by,
    },
  });
  return { status: "queued", station: station.name, online: station.online, orderId, others, reprint, labelId: label.id };
}

export async function labelImage(id: string): Promise<Uint8Array | null> {
  const row = await prisma.shippingLabel.findUnique({ where: { id }, select: { image: true } });
  return row?.image ?? null;
}

// A bad upload (wrong PDF): take the whole batch back out.
export async function deleteBatch(batchId: string): Promise<number> {
  const { count } = await prisma.shippingLabel.deleteMany({ where: { batchId } });
  return count;
}
