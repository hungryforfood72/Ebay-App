import type { LocalDelivery } from "@/generated/prisma/client";
import { mailerConfigured, sendEmail } from "../mailer";
import { prisma } from "../prisma";
import { getLocation, getShopifyConfig, ShopifyApiError, shopifyGraphql, throwOnUserErrors, type UserError } from "../shopify";
import { planRoute, stopLetter, type Point } from "./route";

// Epic Steals free local delivery: Shopify orders whose delivery method is
// Local delivery, from label to doorstep photo. Server only.
//
// Shopify only hands over the buyer's name, address, email and phone once
// the store app has protected customer data access; until then the orders
// come back without an address and the page says what to turn on.

export class DeliveryError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type DeliveryItem = { lineItemId: string; title: string; quantity: number };

export type DeliveryView = {
  id: string;
  orderName: string;
  code: string;
  status: string;
  orderedAt: string;
  name: string;
  address1: string;
  address2: string | null;
  city: string;
  province: string | null;
  zip: string;
  phone: string | null;
  email: string | null;
  lat: number | null;
  lng: number | null;
  items: DeliveryItem[];
  note: string | null;
  // Units picked in the app (OrderPick) out of the order's units.
  picked: number;
  units: number;
  labelPrintedAt: string | null;
  stop: number | null;
  letter: string | null;
  deliveredAt: string | null;
  deliveredBy: string | null;
  photoUrl: string | null;
  failedNote: string | null;
  shopifyDoneAt: string | null;
  emailSentAt: string | null;
  followUpError: string | null;
};

export type ShipFrom = { name: string; address1: string; address2: string | null; city: string; province: string | null; zip: string; phone: string | null; lat: number | null; lng: number | null };

export type DeliveriesResponse = {
  configured: boolean;
  // Open local delivery orders Shopify sent without an address: protected
  // customer data access isn't on yet.
  missingCustomerData: number;
  syncError: string | null;
  emailReady: boolean;
  shipFrom: ShipFrom | null;
  run: { id: string; driver: string | null; startedAt: string; endAtStart: boolean; start: Point } | null;
  deliveries: DeliveryView[];
};

// ---------------------------------------------------------------------------
// Pulling local delivery orders in from Shopify
// ---------------------------------------------------------------------------

type ShopifyDeliveryOrder = {
  id: string;
  name: string;
  createdAt: string;
  email: string | null;
  phone: string | null;
  note: string | null;
  shippingLines: { nodes: { title: string; deliveryCategory: string | null }[] };
  shippingAddress: {
    name: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    zip: string | null;
    phone: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  lineItems: { nodes: { id: string; title: string; currentQuantity: number; unfulfilledQuantity: number }[] };
};

// Same test as the pick list (warehouse/picking.ts): deliveryCategory
// "local", or a method named Local delivery.
function isLocalDelivery(o: ShopifyDeliveryOrder): boolean {
  return o.shippingLines.nodes.some((s) => /^local$/i.test(s.deliveryCategory ?? "") || /local\s*deliver/i.test(s.title));
}

async function openShopifyOrders(): Promise<ShopifyDeliveryOrder[]> {
  const orders: ShopifyDeliveryOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyDeliveryOrder[] } } =
      await shopifyGraphql(
        `query($query: String!, $after: String) {
          orders(first: 50, after: $after, query: $query, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id name createdAt email phone note
              shippingLines(first: 5) { nodes { title deliveryCategory } }
              shippingAddress { name address1 address2 city provinceCode zip phone latitude longitude }
              lineItems(first: 50) { nodes { id title currentQuantity unfulfilledQuantity } }
            }
          }
        }`,
        { query: "status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial)", after }
      );
    orders.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return orders;
}

// Shopify geocodes most addresses itself; this is the fallback. The US
// Census geocoder is free and needs no key.
async function geocode(address: string): Promise<Point | null> {
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(address)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const json = (await res.json()) as { result?: { addressMatches?: { coordinates: { x: number; y: number } }[] } };
    const match = json.result?.addressMatches?.[0];
    return match ? { lat: match.coordinates.y, lng: match.coordinates.x } : null;
  } catch {
    return null;
  }
}

function oneLine(a: { address1: string; address2?: string | null; city: string; province?: string | null; zip: string }): string {
  return [a.address1, a.address2, a.city, [a.province, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

// Copies open local delivery orders into LocalDelivery. A row already on a
// run or delivered keeps its address and items; one that's no longer open
// on Shopify (fulfilled or cancelled there) is marked gone.
async function syncFromShopify(): Promise<{ missingCustomerData: number }> {
  const orders = (await openShopifyOrders()).filter(isLocalDelivery);
  let missingCustomerData = 0;
  const seen = new Set<string>();
  for (const o of orders) {
    const a = o.shippingAddress;
    if (!a?.address1 || !a.zip) {
      missingCustomerData++;
      continue;
    }
    seen.add(o.id);
    const items: DeliveryItem[] = o.lineItems.nodes
      .filter((li) => li.currentQuantity > 0)
      .map((li) => ({ lineItemId: li.id, title: li.title, quantity: li.currentQuantity }));
    const fields = {
      name: a.name?.trim() || "Customer",
      address1: a.address1,
      address2: a.address2 || null,
      city: a.city ?? "",
      province: a.provinceCode,
      zip: a.zip,
      phone: a.phone || o.phone || null,
      email: o.email,
      items,
      note: o.note,
    };
    const existing = await prisma.localDelivery.findUnique({ where: { shopifyOrderId: o.id } });
    if (!existing) {
      await prisma.localDelivery.create({
        data: {
          shopifyOrderId: o.id,
          orderName: o.name,
          code: `D${o.name.replace(/\D/g, "") || o.id.replace(/\D/g, "")}`,
          orderedAt: new Date(o.createdAt),
          lat: a.latitude,
          lng: a.longitude,
          ...fields,
        },
      });
    } else if (existing.status === "ready" || existing.status === "failed" || existing.status === "gone") {
      const moved = existing.address1 !== a.address1 || existing.zip !== a.zip;
      await prisma.localDelivery.update({
        where: { id: existing.id },
        data: {
          ...fields,
          status: existing.status === "gone" ? "ready" : existing.status,
          ...(moved ? { lat: a.latitude, lng: a.longitude } : {}),
        },
      });
    }
  }
  await prisma.localDelivery.updateMany({
    where: { status: { in: ["ready", "failed"] }, shopifyOrderId: { notIn: [...seen] } },
    data: { status: "gone" },
  });
  // Shopify left some without coordinates: look them up once.
  const unplaced = await prisma.localDelivery.findMany({ where: { status: { in: ["ready", "failed"] }, lat: null } });
  for (const d of unplaced) {
    const point = await geocode(oneLine(d));
    if (point) await prisma.localDelivery.update({ where: { id: d.id }, data: point });
  }
  return { missingCustomerData };
}

// ---------------------------------------------------------------------------
// Ship-from (the store's own address, for the label and the start point)
// ---------------------------------------------------------------------------

const SHIP_FROM_KEY = "delivery.shipFrom";

export async function getShipFrom(): Promise<ShipFrom | null> {
  const cached = await prisma.appSetting.findUnique({ where: { key: SHIP_FROM_KEY } });
  if (cached) return JSON.parse(cached.value) as ShipFrom;
  if (!getShopifyConfig()) return null;
  const location = await getLocation();
  const data = await shopifyGraphql<{
    location: { address: { address1: string | null; address2: string | null; city: string | null; provinceCode: string | null; zip: string | null; phone: string | null } } | null;
    shop: { name: string };
  }>(`query($id: ID!) { location(id: $id) { address { address1 address2 city provinceCode zip phone } } shop { name } }`, { id: location.id });
  const a = data.location?.address;
  if (!a?.address1 || !a.zip) return null;
  const base = { name: data.shop.name, address1: a.address1, address2: a.address2, city: a.city ?? "", province: a.provinceCode, zip: a.zip, phone: a.phone };
  const point = await geocode(oneLine(base));
  const shipFrom: ShipFrom = { ...base, lat: point?.lat ?? null, lng: point?.lng ?? null };
  await prisma.appSetting.upsert({
    where: { key: SHIP_FROM_KEY },
    create: { key: SHIP_FROM_KEY, value: JSON.stringify(shipFrom) },
    update: { value: JSON.stringify(shipFrom) },
  });
  return shipFrom;
}

// ---------------------------------------------------------------------------
// The page's data
// ---------------------------------------------------------------------------

async function pickedUnits(deliveries: LocalDelivery[]): Promise<Map<string, number>> {
  const picks = await prisma.orderPick.groupBy({
    by: ["orderId", "lineItemId"],
    where: { channel: "shopify", orderId: { in: deliveries.map((d) => d.shopifyOrderId) } },
    _count: { _all: true },
  });
  const result = new Map<string, number>();
  for (const d of deliveries) {
    let picked = 0;
    for (const item of d.items as DeliveryItem[]) {
      const p = picks.find((x) => x.orderId === d.shopifyOrderId && x.lineItemId === item.lineItemId)?._count._all ?? 0;
      picked += Math.min(p, item.quantity);
    }
    result.set(d.id, picked);
  }
  return result;
}

function view(d: LocalDelivery, picked: number): DeliveryView {
  const items = d.items as DeliveryItem[];
  const iso = (t: Date | null) => t?.toISOString() ?? null;
  return {
    id: d.id,
    orderName: d.orderName,
    code: d.code,
    status: d.status,
    orderedAt: d.orderedAt.toISOString(),
    name: d.name,
    address1: d.address1,
    address2: d.address2,
    city: d.city,
    province: d.province,
    zip: d.zip,
    phone: d.phone,
    email: d.email,
    lat: d.lat,
    lng: d.lng,
    items,
    note: d.note,
    picked,
    units: items.reduce((sum, i) => sum + i.quantity, 0),
    labelPrintedAt: iso(d.labelPrintedAt),
    stop: d.stop,
    letter: d.stop != null ? stopLetter(d.stop) : null,
    deliveredAt: iso(d.deliveredAt),
    deliveredBy: d.deliveredBy,
    photoUrl: d.photoUrl,
    failedNote: d.failedNote,
    shopifyDoneAt: iso(d.shopifyDoneAt),
    emailSentAt: iso(d.emailSentAt),
    followUpError: d.followUpError,
  };
}

export async function getDeliveries(options: { sync: boolean }): Promise<DeliveriesResponse> {
  const configured = Boolean(getShopifyConfig());
  let missingCustomerData = 0;
  let syncError: string | null = null;
  if (configured && options.sync) {
    try {
      ({ missingCustomerData } = await syncFromShopify());
    } catch (e) {
      syncError = e instanceof Error ? e.message : String(e);
    }
  }
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const rows = await prisma.localDelivery.findMany({
    where: { OR: [{ status: { in: ["ready", "out", "failed"] } }, { status: "delivered", deliveredAt: { gte: since } }] },
    orderBy: [{ stop: "asc" }, { orderedAt: "asc" }],
  });
  const [picked, run, shipFrom] = await Promise.all([
    pickedUnits(rows),
    prisma.deliveryRun.findFirst({ where: { finishedAt: null }, orderBy: { startedAt: "desc" } }),
    configured ? getShipFrom().catch(() => null) : Promise.resolve(null),
  ]);
  return {
    configured,
    missingCustomerData,
    syncError,
    emailReady: mailerConfigured(),
    shipFrom,
    run: run
      ? { id: run.id, driver: run.driver, startedAt: run.startedAt.toISOString(), endAtStart: run.endAtStart, start: { lat: run.startLat, lng: run.startLng } }
      : null,
    deliveries: rows.map((d) => view(d, picked.get(d.id) ?? 0)),
  };
}

// The delivery for one Shopify order, for printing its label at packing.
// Pulls from Shopify first if the app hasn't seen the order yet.
export async function deliveryForOrder(shopifyOrderId: string): Promise<DeliveryView | null> {
  let row = await prisma.localDelivery.findUnique({ where: { shopifyOrderId } });
  if (!row && getShopifyConfig()) {
    await syncFromShopify();
    row = await prisma.localDelivery.findUnique({ where: { shopifyOrderId } });
  }
  if (!row) return null;
  return view(row, (await pickedUnits([row])).get(row.id) ?? 0);
}

export async function markLabelPrinted(ids: string[]): Promise<void> {
  await prisma.localDelivery.updateMany({ where: { id: { in: ids } }, data: { labelPrintedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// Puts the chosen ready (or failed, trying again) deliveries on a new run in
// driving order. start: the phone's location, or the shop when the driver
// didn't share it.
export async function startRun(input: { ids: string[]; start: Point | null; endAtStart: boolean; driver: string | null }) {
  const open = await prisma.deliveryRun.findFirst({ where: { finishedAt: null } });
  if (open) throw new DeliveryError("A route is already going. Finish it before starting another.", 409);
  const deliveries = await prisma.localDelivery.findMany({ where: { id: { in: input.ids }, status: { in: ["ready", "failed"] } } });
  if (deliveries.length === 0) throw new DeliveryError("Pick at least one delivery for the route.");
  let start = input.start;
  if (!start) {
    const shipFrom = await getShipFrom();
    if (shipFrom?.lat == null || shipFrom.lng == null) throw new DeliveryError("Couldn't tell where you're starting. Allow location on this phone and try again.");
    start = { lat: shipFrom.lat, lng: shipFrom.lng };
  }
  // Anything still without coordinates goes last, in order placed.
  const placed = deliveries.filter((d) => d.lat != null && d.lng != null);
  const unplaced = deliveries.filter((d) => d.lat == null || d.lng == null);
  const order = planRoute(start, placed.map((d) => ({ lat: d.lat!, lng: d.lng! })), input.endAtStart);
  const sequence = [...order.map((i) => placed[i]), ...unplaced];
  return prisma.$transaction(async (tx) => {
    const run = await tx.deliveryRun.create({
      data: { driver: input.driver, startLat: start.lat, startLng: start.lng, endAtStart: input.endAtStart },
    });
    for (const [i, d] of sequence.entries()) {
      await tx.localDelivery.update({ where: { id: d.id }, data: { status: "out", runId: run.id, stop: i, failedNote: null } });
    }
    return run;
  });
}

// Ends the run. Stops not reached go back to ready for the next one.
export async function finishRun(runId: string): Promise<void> {
  await prisma.$transaction([
    prisma.localDelivery.updateMany({ where: { runId, status: "out" }, data: { status: "ready", runId: null, stop: null } }),
    prisma.deliveryRun.update({ where: { id: runId }, data: { finishedAt: new Date() } }),
  ]);
}

async function finishRunIfDone(runId: string | null): Promise<void> {
  if (!runId) return;
  const left = await prisma.localDelivery.count({ where: { runId, status: "out" } });
  if (left === 0) await prisma.deliveryRun.update({ where: { id: runId }, data: { finishedAt: new Date() } });
}

// The bag couldn't be dropped off (gate locked, wrong address). Back to the
// queue with the reason; it can go on the next run.
export async function markFailed(id: string, note: string): Promise<void> {
  const d = await prisma.localDelivery.findUnique({ where: { id } });
  if (!d || d.status !== "out") throw new DeliveryError("That stop isn't on the route anymore.", 404);
  await prisma.localDelivery.update({ where: { id }, data: { status: "failed", failedNote: note.trim() || "Couldn't deliver", runId: null, stop: null } });
  await finishRunIfDone(d.runId);
}

// ---------------------------------------------------------------------------
// Delivered: the photo, Shopify, and the customer's email
// ---------------------------------------------------------------------------

// The driver scanned the label (code must match this stop) and took the
// photo. The drop-off is recorded first; Shopify and the email follow and
// any that fail can be retried without losing it.
export async function markDelivered(input: { id: string; code: string; photoUrl: string; by: string | null }): Promise<DeliveryView> {
  const d = await prisma.localDelivery.findUnique({ where: { id: input.id } });
  if (!d || d.status !== "out") throw new DeliveryError("That stop isn't on the route anymore.", 404);
  if (input.code.trim().toUpperCase() !== d.code) throw new DeliveryError(`That label is ${input.code}, not ${d.code}. Wrong bag.`, 409);
  if (!/^https:\/\/res\.cloudinary\.com\//.test(input.photoUrl)) throw new DeliveryError("Take the delivery photo first.");
  const delivered = await prisma.localDelivery.update({
    where: { id: d.id },
    data: { status: "delivered", deliveredAt: new Date(), deliveredBy: input.by, photoUrl: input.photoUrl },
  });
  await finishRunIfDone(d.runId);
  const done = await followUp(delivered.id);
  return view(done, (done.items as DeliveryItem[]).reduce((s, i) => s + i.quantity, 0));
}

// Shopify then email, each only if not done yet. Safe to run again.
export async function followUp(id: string): Promise<LocalDelivery> {
  let d = await prisma.localDelivery.findUniqueOrThrow({ where: { id } });
  if (d.status !== "delivered") throw new DeliveryError("Only delivered stops get the follow-up.");
  const problems: string[] = [];
  if (!d.shopifyDoneAt) {
    try {
      await completeOnShopify(d);
      d = await prisma.localDelivery.update({ where: { id }, data: { shopifyDoneAt: new Date() } });
    } catch (e) {
      problems.push(`Shopify: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!d.emailSentAt) {
    if (!d.email) {
      problems.push("Email: this order has no email address.");
    } else {
      try {
        await sendEmail(deliveredEmail(d));
        d = await prisma.localDelivery.update({ where: { id }, data: { emailSentAt: new Date() } });
      } catch (e) {
        problems.push(`Email: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return prisma.localDelivery.update({ where: { id }, data: { followUpError: problems.length ? problems.join(" ") : null } });
}

const CHICAGO_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// Fulfills whatever is still open on the order (no Shopify email: ours has
// the photo), marks that fulfillment delivered, and adds the photo link to
// the order note so it's on the order for good.
async function completeOnShopify(d: LocalDelivery): Promise<void> {
  const data = await shopifyGraphql<{
    order: { note: string | null; fulfillmentOrders: { nodes: { id: string; status: string }[] }; fulfillments: { id: string }[] } | null;
  }>(
    `query($id: ID!) { order(id: $id) { note fulfillmentOrders(first: 10) { nodes { id status } } fulfillments(first: 10) { id } } }`,
    { id: d.shopifyOrderId }
  );
  if (!data.order) throw new ShopifyApiError("The order isn't on Shopify anymore.");
  const open = data.order.fulfillmentOrders.nodes.filter((f) => f.status === "OPEN" || f.status === "IN_PROGRESS");
  let fulfillmentId = data.order.fulfillments.at(-1)?.id ?? null;
  if (open.length > 0) {
    const created = await shopifyGraphql<{ fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: UserError[] } }>(
      `mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } } }`,
      { fulfillment: { lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })), notifyCustomer: false } }
    );
    throwOnUserErrors("Couldn't fulfill the order", created.fulfillmentCreate.userErrors);
    fulfillmentId = created.fulfillmentCreate.fulfillment?.id ?? fulfillmentId;
  }
  const when = d.deliveredAt ?? new Date();
  if (fulfillmentId) {
    const event = await shopifyGraphql<{ fulfillmentEventCreate: { userErrors: UserError[] } }>(
      `mutation($fulfillmentEvent: FulfillmentEventInput!) { fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) { fulfillmentEvent { id } userErrors { field message } } }`,
      { fulfillmentEvent: { fulfillmentId, status: "DELIVERED", happenedAt: when.toISOString(), message: `Delivered by Epic Steals. Photo: ${d.photoUrl}` } }
    );
    throwOnUserErrors("Couldn't mark it delivered", event.fulfillmentEventCreate.userErrors);
  }
  const line = `Delivered ${CHICAGO_TIME.format(when)}${d.deliveredBy ? ` by ${d.deliveredBy}` : ""}. Photo: ${d.photoUrl}`;
  const note = data.order.note?.includes(d.photoUrl ?? "\u0000") ? data.order.note : [data.order.note, line].filter(Boolean).join("\n");
  const updated = await shopifyGraphql<{ orderUpdate: { userErrors: UserError[] } }>(
    `mutation($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }`,
    { input: { id: d.shopifyOrderId, note } }
  );
  throwOnUserErrors("Couldn't add the photo to the order note", updated.orderUpdate.userErrors);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// A smaller copy of the photo for the email; the full one stays on the order.
function emailPhoto(url: string): string {
  return url.replace("/image/upload/", "/image/upload/c_limit,w_1200,q_auto/");
}

function deliveredEmail(d: LocalDelivery) {
  const first = d.name.split(/\s+/)[0] || "there";
  const when = CHICAGO_TIME.format(d.deliveredAt ?? new Date());
  const items = (d.items as DeliveryItem[]).map((i) => `${i.quantity > 1 ? `${i.quantity} x ` : ""}${i.title}`);
  const photo = emailPhoto(d.photoUrl!);
  return {
    to: d.email!,
    subject: `Your Epic Steals order ${d.orderName} was delivered`,
    text: [
      `Hi ${first},`,
      "",
      `Your order ${d.orderName} was delivered on ${when} to ${oneLine(d)}.`,
      `Here's the photo we took at drop-off: ${photo}`,
      "",
      ...items.map((i) => `- ${i}`),
      "",
      "Questions? Just reply to this email.",
      "Thanks for shopping local with Epic Steals!",
    ].join("\n"),
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#15134A">
  <h2 style="margin:0 0 8px">Your order was delivered!</h2>
  <p style="margin:0 0 16px">Hi ${escapeHtml(first)}, your Epic Steals order <b>${escapeHtml(d.orderName)}</b> was delivered on <b>${escapeHtml(when)}</b> to ${escapeHtml(oneLine(d))}.</p>
  <p style="margin:0 0 8px">Here's the photo we took at drop-off:</p>
  <img src="${escapeHtml(photo)}" alt="Your package at drop-off" style="width:100%;max-width:560px;border-radius:12px;display:block">
  <ul style="padding-left:18px;margin:16px 0">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
  <p style="margin:0 0 4px">Questions? Just reply to this email.</p>
  <p style="margin:0;color:#F3723A;font-weight:bold">Thanks for shopping local with Epic Steals!</p>
</div>`,
  };
}
