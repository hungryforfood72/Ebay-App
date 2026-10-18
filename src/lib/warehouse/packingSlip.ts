import type { Prisma } from "@/generated/prisma/client";
import { code128Bits } from "@/components/labels/barcode";
import { deliveryForOrder, getShipFrom, markLabelPrinted } from "../delivery/deliveries";
import { deliveryLabelsDocument } from "../delivery/label";
import { prisma } from "../prisma";
import { orderForSlip, type OrderForSlip, type PickChannel } from "./picking";
import { STATION_ONLINE_MS } from "./settings";
import type { PageJobKind, PageJobPayload } from "./types";

// Packing slips (Cristian, 2026-10-17): when the last item of an order is
// picked, a 4x6 slip prints at the packing station so whoever packs knows
// which items go together. Every channel (eBay, Shopify, Whatnot); counter
// sales don't get one. A local delivery order also gets its delivery label
// in the same go. Shipping labels themselves are still bought in eBay and
// Shopify. Server only.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function barcode(code: string): string {
  const bits = code128Bits(code);
  if (!bits) return "";
  let rects = "";
  for (let i = 0; i < bits.length; ) {
    if (bits[i] !== "1") {
      i++;
      continue;
    }
    let j = i;
    while (j < bits.length && bits[j] === "1") j++;
    rects += `<rect x="${i}" y="0" width="${j - i}" height="1"/>`;
    i = j;
  }
  const width = Math.min(3.4, bits.length * 0.02);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bits.length} 1" preserveAspectRatio="none" shape-rendering="crispEdges" style="display:block;margin:0 auto;width:${width}in;height:0.5in">${rects}</svg>`;
}

const HANDOFF_BANNER: Record<string, string | null> = {
  ship: null,
  pickup: "PICKUP: to the hand-over spot",
  delivery: "LOCAL DELIVERY: set aside for driver",
  counter: null,
};

const CHICAGO_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" });

export function packingSlipHtml(order: OrderForSlip, by: string | null): string {
  const banner = HANDOFF_BANNER[order.handoff];
  const units = order.lines.reduce((sum, l) => sum + l.quantity, 0);
  const rows = order.lines
    .map(
      (l) => `<tr><td class="box"></td><td class="qty">${l.quantity}</td><td>${esc(l.title)}${l.code ? `<div class="sku">${esc(l.code)}</div>` : ""}</td></tr>`
    )
    .join("");
  const number = order.orderNumber.replace(/^#/, "");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: 4in 6in; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 4in; }
body { font-family: Arial, Helvetica, sans-serif; color: #000; }
.slip { width: 4in; min-height: 6in; padding: 0.16in 0.18in; display: flex; flex-direction: column; gap: 0.07in; }
header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid #000; padding-bottom: 0.04in; }
h1 { font-size: 13pt; letter-spacing: 1px; }
.source { font-size: 11pt; font-weight: 900; border: 2px solid #000; padding: 0.01in 0.06in; }
.order { font-size: 20pt; font-weight: 900; line-height: 1.05; word-break: break-all; }
.meta { font-size: 9pt; }
.banner { background: #000; color: #fff; font-weight: 900; font-size: 11pt; padding: 0.05in 0.08in; text-align: center; }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
th { text-align: left; font-size: 7pt; letter-spacing: 1px; border-bottom: 1px solid #000; padding-bottom: 0.02in; }
td { padding: 0.05in 0.04in 0.05in 0; vertical-align: top; border-bottom: 1px solid #bbb; line-height: 1.2; }
td.box { width: 0.22in; } td.box::before { content: ""; display: block; width: 0.14in; height: 0.14in; border: 1.5px solid #000; }
td.qty { width: 0.32in; font-weight: 900; font-size: 12pt; }
.sku { font-size: 7.5pt; font-family: "Courier New", monospace; margin-top: 0.01in; }
footer { margin-top: auto; font-size: 7.5pt; text-align: center; border-top: 1px solid #000; padding-top: 0.04in; }
</style></head><body><section class="slip">
  <header><h1>PACKING SLIP</h1><span class="source">${esc(order.source.toUpperCase())}</span></header>
  <p class="order">${esc(order.orderNumber)}</p>
  <p class="meta">${order.buyer ? `${esc(order.buyer)} · ` : ""}Ordered ${CHICAGO_DAY.format(new Date(order.orderedAt))} · ${units} item${units === 1 ? "" : "s"}</p>
  ${banner ? `<p class="banner">${esc(banner)}</p>` : ""}
  ${barcode(number)}
  <table><thead><tr><th></th><th>QTY</th><th>ITEM</th></tr></thead><tbody>${rows}</tbody></table>
  <footer>Picked${by ? ` by ${esc(by)}` : ""} · ${CHICAGO_DAY.format(new Date())}${order.handoff === "delivery" ? " · Keep this slip inside the bag" : ""}</footer>
</section></body></html>`;
}

// The station marked for packing slips, if its page is open right now (or
// was recently: a job queued while it reloads still prints).
async function packingStation() {
  const station = await prisma.station.findFirst({ where: { packingSlips: true }, orderBy: { lastSeenAt: "desc" } });
  if (!station) return null;
  const online = station.lastSeenAt != null && Date.now() - station.lastSeenAt.getTime() <= STATION_ONLINE_MS;
  return { id: station.id, name: station.name, online };
}

export type SlipResult =
  // Sent to the packing station. delivery: the local delivery label went
  // with it (false = it's a delivery but had no address yet).
  | { status: "queued"; station: string; online: boolean; delivery: boolean | null }
  // Reprint with no packing station set up: the page prints these itself.
  | { status: "print_here"; pages: string[] }
  // no_station: fully picked, but there's no packing station to send it to
  // (the handheld doesn't pop a print dialog mid-pick; the Packing slip
  // button on Ready to pack prints it).
  | { status: "already" | "not_ready" | "not_found" | "counter" | "no_station" };

async function queuePage(tx: Prisma.TransactionClient | typeof prisma, stationId: string, kind: PageJobKind, payload: PageJobPayload, by: string | null) {
  await tx.printJob.create({ data: { stationId, kind, payload: payload as Prisma.InputJsonValue, copies: 1, createdBy: by } });
}

// After a pick: prints the slip the first time the order is fully picked.
// force (the Reprint button): prints it again, picked or not.
export async function printPackingSlip(input: { channel: PickChannel; orderId: string; by: string | null; force: boolean }): Promise<SlipResult> {
  if (!input.force) {
    const done = await prisma.packingSlip.findUnique({ where: { channel_orderId: { channel: input.channel, orderId: input.orderId } } });
    if (done) return { status: "already" };
  }
  const order = await orderForSlip(input.channel, input.orderId);
  if (!order) return { status: "not_found" };
  if (order.handoff === "counter") return { status: "counter" };
  if (!input.force && !order.fullyPicked) return { status: "not_ready" };

  // Cheap check first: no station and not a reprint means nothing to do.
  if (!input.force && !(await packingStation())) return { status: "no_station" };
  const pages: { kind: PageJobKind; payload: PageJobPayload }[] = [
    { kind: "packing_slip", payload: { code: `Slip ${order.orderNumber}`, html: packingSlipHtml(order, input.by) } },
  ];
  let delivery: boolean | null = null;
  let deliveryId: string | null = null;
  if (order.handoff === "delivery" && order.channel === "shopify") {
    const d = await deliveryForOrder(order.orderId).catch(() => null);
    delivery = d != null;
    if (d) {
      deliveryId = d.id;
      pages.push({ kind: "delivery_label", payload: { code: `Delivery ${d.code}`, html: deliveryLabelsDocument([d], await getShipFrom().catch(() => null)) } });
    }
  }

  const station = await packingStation();
  if (!station && !input.force) return { status: "no_station" };
  await prisma.packingSlip.upsert({
    where: { channel_orderId: { channel: order.channel, orderId: order.orderId } },
    create: { channel: order.channel, orderId: order.orderId, orderNumber: order.orderNumber, printedBy: input.by },
    update: { printedBy: input.by },
  });
  if (deliveryId) await markLabelPrinted([deliveryId]);
  if (!station) return { status: "print_here", pages: pages.map((p) => p.payload.html) };
  await prisma.$transaction(async (tx) => {
    for (const p of pages) await queuePage(tx, station.id, p.kind, p.payload, input.by);
  });
  return { status: "queued", station: station.name, online: station.online, delivery };
}
