import type { Prisma } from "@/generated/prisma/client";
import { code128Bits } from "@/components/labels/barcode";
import { getOrderShipTo } from "../ebay";
import { shopifyGraphql } from "../shopify";
import { deliveryForOrder, getShipFrom, markLabelPrinted } from "../delivery/deliveries";
import { deliveryLabelsDocument } from "../delivery/label";
import { prisma } from "../prisma";
import { ordersShippingTogether, type OrderForSlip, type PickChannel } from "./picking";
import { STATION_ONLINE_MS } from "./settings";
import type { PageJobKind, PageJobPayload } from "./types";

// Packing slips (Cristian, 2026-10-17): when the last item of an order is
// picked, a 4x6 slip prints at the packing station so whoever packs knows
// which items go together. Every channel (eBay, Shopify, Whatnot); counter
// sales don't get one. A local delivery order also gets its delivery label
// in the same go. Shipping labels themselves are still bought in eBay and
// Shopify. Server only.
//
// Ship-together orders (Cristian, 2026-10-21): when one eBay buyer has
// several open orders to one address, they go in one box, so they get one
// slip, printed once the last of them is fully picked. It lists every order
// with its own barcode; scanning any of them prints the combined label.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function barcode(code: string, height = 0.5): string {
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bits.length} 1" preserveAspectRatio="none" shape-rendering="crispEdges" style="display:block;margin:0 auto;width:${width}in;height:${height}in">${rects}</svg>`;
}

const HANDOFF_BANNER: Record<string, string | null> = {
  ship: null,
  pickup: "PICKUP: to the hand-over spot",
  delivery: "LOCAL DELIVERY: set aside for driver",
  counter: null,
};

const CHICAGO_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric" });

// The buyer's full name and address (Cristian, 2026-10-19). Read from the
// store at print time, never kept: once the station says the slip printed,
// the address comes back out of the saved job (stripShipTo), and a Reprint
// reads it fresh again.
export type ShipTo = { name: string; lines: string[] };

const SHIP_TO_START = "<!--shipto-->";
const SHIP_TO_END = "<!--/shipto-->";

export function stripShipTo(html: string): string {
  return html.replace(/<!--shipto-->[\s\S]*?<!--\/shipto-->/g, "");
}

// null = no address to show: a pickup or counter sale, or the store didn't
// give one (Shopify sends none until the store app has protected customer
// data access).
export async function shipToForSlip(order: OrderForSlip): Promise<ShipTo | null> {
  if (order.handoff === "pickup" || order.handoff === "counter") return null;
  try {
    if (order.channel === "ebay") return await getOrderShipTo(order.orderId);
    const data = await shopifyGraphql<{
      order: {
        shippingAddress: {
          name: string | null;
          address1: string | null;
          address2: string | null;
          city: string | null;
          provinceCode: string | null;
          zip: string | null;
          countryCodeV2: string | null;
        } | null;
      } | null;
    }>(`query($id: ID!) { order(id: $id) { shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 } } }`, {
      id: order.orderId,
    });
    const a = data.order?.shippingAddress;
    if (!a?.name && !a?.address1) return null;
    const cityLine = [a.city, [a.provinceCode, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return {
      name: a.name?.trim() ?? "",
      lines: [a.address1, a.address2, cityLine, a.countryCodeV2 && a.countryCodeV2 !== "US" ? a.countryCodeV2 : null]
        .map((l) => l?.trim())
        .filter((l): l is string => Boolean(l)),
    };
  } catch (e) {
    // The slip still prints, just without the address.
    console.error(`[packingSlip] couldn't read the ship-to for ${order.channel} order ${order.orderNumber}`, e);
    return null;
  }
}

function itemRows(order: OrderForSlip): string {
  return order.lines
    .map(
      (l) => `<tr><td class="box"></td><td class="qty">${l.quantity}</td><td>${esc(l.title)}${l.code ? `<div class="sku">${esc(l.code)}</div>` : ""}</td></tr>`
    )
    .join("");
}

const unitCount = (orders: OrderForSlip[]) => orders.reduce((sum, o) => sum + o.lines.reduce((n, l) => n + l.quantity, 0), 0);

// orders: one order, or a ship-together group (oldest first). printedBefore:
// orders in the group whose own slip already printed (it was picked and
// slipped before the newer order came in), so their box is already made up.
export function packingSlipHtml(orders: OrderForSlip[], by: string | null, shipTo: ShipTo | null = null, printedBefore: Set<string> = new Set()): string {
  const order = orders[0];
  const combined = orders.length > 1;
  const banner = HANDOFF_BANNER[order.handoff];
  const units = unitCount(orders);
  const table = (o: OrderForSlip) => `<table><thead><tr><th></th><th>QTY</th><th>ITEM</th></tr></thead><tbody>${itemRows(o)}</tbody></table>`;
  const body = combined
    ? orders
        .map(
          (o) => `<div class="part"><p class="partno">${esc(o.orderNumber)}</p>${
            printedBefore.has(o.orderId) ? `<p class="earlier">Slip printed earlier: find that box and add it in</p>` : ""
          }${barcode(o.orderNumber.replace(/^#/, ""), 0.38)}${table(o)}</div>`
        )
        .join("")
    : `${barcode(order.orderNumber.replace(/^#/, ""))}${table(order)}`;
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
.shipto { border: 1.5px solid #000; padding: 0.05in 0.08in; font-size: 10pt; line-height: 1.25; }
.shipto .label { font-size: 7pt; letter-spacing: 1px; font-weight: 700; }
.shipto .name { font-size: 12pt; font-weight: 900; }
.banner { background: #000; color: #fff; font-weight: 900; font-size: 11pt; padding: 0.05in 0.08in; text-align: center; }
.part { border-top: 2px solid #000; padding-top: 0.04in; display: flex; flex-direction: column; gap: 0.04in; }
.partno { font-size: 13pt; font-weight: 900; word-break: break-all; }
.earlier { font-size: 8.5pt; font-weight: 700; }
table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
th { text-align: left; font-size: 7pt; letter-spacing: 1px; border-bottom: 1px solid #000; padding-bottom: 0.02in; }
td { padding: 0.05in 0.04in 0.05in 0; vertical-align: top; border-bottom: 1px solid #bbb; line-height: 1.2; }
td.box { width: 0.22in; } td.box::before { content: ""; display: block; width: 0.14in; height: 0.14in; border: 1.5px solid #000; }
td.qty { width: 0.32in; font-weight: 900; font-size: 12pt; }
.sku { font-size: 7.5pt; font-family: "Courier New", monospace; margin-top: 0.01in; }
footer { margin-top: auto; font-size: 7.5pt; text-align: center; border-top: 1px solid #000; padding-top: 0.04in; }
</style></head><body><section class="slip">
  <header><h1>PACKING SLIP</h1><span class="source">${esc(order.source.toUpperCase())}</span></header>
  ${combined ? `<p class="order">${orders.length} ORDERS, ONE BOX</p>` : `<p class="order">${esc(order.orderNumber)}</p>`}
  <p class="meta">${order.buyer && !shipTo ? `${esc(order.buyer)} · ` : ""}${combined ? "Same buyer, same address" : `Ordered ${CHICAGO_DAY.format(new Date(order.orderedAt))}`} · ${units} item${units === 1 ? "" : "s"}</p>
  ${
    shipTo
      ? `${SHIP_TO_START}<div class="shipto"><p class="label">SHIP TO</p>${shipTo.name ? `<p class="name">${esc(shipTo.name)}</p>` : ""}${shipTo.lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div>${SHIP_TO_END}`
      : ""
  }
  ${combined ? `<p class="banner">COMBINE: one box, one label</p>` : ""}
  ${banner ? `<p class="banner">${esc(banner)}</p>` : ""}
  ${body}
  <footer>Picked${by ? ` by ${esc(by)}` : ""} · ${CHICAGO_DAY.format(new Date())}${order.handoff === "delivery" ? " · Keep this slip inside the bag" : ""}</footer>
</section></body></html>`;
}

// The station marked for packing slips, if its page is open right now (or
// was recently: a job queued while it reloads still prints). Shipping
// labels go here too.
export async function packingStation() {
  const station = await prisma.station.findFirst({
    where: { packingSlips: true, slipPrinter: false },
    orderBy: { lastSeenAt: "desc" },
  });
  if (!station) return null;
  const online = station.lastSeenAt != null && Date.now() - station.lastSeenAt.getTime() <= STATION_ONLINE_MS;
  return { id: station.id, name: station.name, online };
}

// Where a packing slip goes (Cristian, 2026-10-21): the Wi-Fi Rollo run by
// the slip printer helper when it's online, otherwise the packing station
// as before, so slips still print if the helper's PC is off.
export async function slipStation() {
  const printer = await prisma.station.findFirst({ where: { slipPrinter: true }, orderBy: { lastSeenAt: "desc" } });
  if (printer?.lastSeenAt && Date.now() - printer.lastSeenAt.getTime() <= STATION_ONLINE_MS) {
    return { id: printer.id, name: printer.name, online: true };
  }
  return packingStation();
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
  | { status: "already" | "not_ready" | "not_found" | "counter" | "no_station" }
  // This order is fully picked, but it ships with other orders that
  // aren't yet: hold it. The one slip prints when the last one is.
  | { status: "hold_for_combine"; waitingOn: string[] };

async function slipPayload(orders: OrderForSlip[], by: string | null): Promise<PageJobPayload> {
  const order = orders[0];
  const printedBefore = new Set<string>();
  if (orders.length > 1) {
    const rows = await prisma.packingSlip.findMany({
      where: { channel: order.channel, orderId: { in: orders.map((o) => o.orderId) } },
      select: { orderId: true, createdAt: true },
    });
    // Printed on its own, before this group's slip. A group slip writes a
    // row for every order in it at the same moment, so on a reprint those
    // match and only an order slipped earlier stands out.
    const latest = rows.length < orders.length ? Date.now() : Math.max(...rows.map((r) => r.createdAt.getTime()));
    for (const r of rows) if (latest - r.createdAt.getTime() > 60_000) printedBefore.add(r.orderId);
  }
  return {
    code: orders.length > 1 ? `Slip ${order.orderNumber} +${orders.length - 1}` : `Slip ${order.orderNumber}`,
    html: packingSlipHtml(orders, by, await shipToForSlip(order), printedBefore),
    order: { channel: order.channel, orderId: order.orderId },
  };
}

// The station log's Reprint on a packing slip: the slip built again, so
// the address (stripped once it printed) is back on it. null = the order
// isn't open anymore (already shipped); reprint the saved copy instead.
export async function rebuildSlipPayload(channel: PickChannel, orderId: string, by: string | null): Promise<PageJobPayload | null> {
  const orders = await ordersShippingTogether(channel, orderId).catch(() => []);
  return orders.length > 0 ? slipPayload(orders, by) : null;
}

async function queuePage(tx: Prisma.TransactionClient | typeof prisma, stationId: string, kind: PageJobKind, payload: PageJobPayload, by: string | null) {
  await tx.printJob.create({ data: { stationId, kind, payload: payload as Prisma.InputJsonValue, copies: 1, createdBy: by } });
}

// After a pick: prints the slip the first time the order is fully picked
// (for ship-together orders, once all of them are). force (the Reprint
// button): prints it again, picked or not, with the whole group on it.
export async function printPackingSlip(input: { channel: PickChannel; orderId: string; by: string | null; force: boolean }): Promise<SlipResult> {
  if (!input.force) {
    const done = await prisma.packingSlip.findUnique({ where: { channel_orderId: { channel: input.channel, orderId: input.orderId } } });
    if (done) return { status: "already" };
  }
  const orders = await ordersShippingTogether(input.channel, input.orderId);
  const order = orders.find((o) => o.orderId === input.orderId);
  if (!order) return { status: "not_found" };
  if (order.handoff === "counter") return { status: "counter" };
  if (!input.force && !order.fullyPicked) return { status: "not_ready" };
  if (!input.force) {
    const waitingOn = orders.filter((o) => o.checkable && !o.fullyPicked).map((o) => o.orderNumber);
    if (waitingOn.length > 0) return { status: "hold_for_combine", waitingOn };
  }

  // Cheap check first: no station and not a reprint means nothing to do.
  if (!input.force && !(await slipStation())) return { status: "no_station" };
  const pages: { kind: PageJobKind; payload: PageJobPayload }[] = [
    { kind: "packing_slip", payload: await slipPayload(orders, input.by) },
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

  const station = await slipStation();
  if (!station && !input.force) return { status: "no_station" };
  for (const o of orders) {
    await prisma.packingSlip.upsert({
      where: { channel_orderId: { channel: o.channel, orderId: o.orderId } },
      create: { channel: o.channel, orderId: o.orderId, orderNumber: o.orderNumber, printedBy: input.by },
      update: { printedBy: input.by },
    });
  }
  if (deliveryId) await markLabelPrinted([deliveryId]);
  if (!station) return { status: "print_here", pages: pages.map((p) => p.payload.html) };
  await prisma.$transaction(async (tx) => {
    for (const p of pages) await queuePage(tx, station.id, p.kind, p.payload, input.by);
  });
  return { status: "queued", station: station.name, online: station.online, delivery };
}
