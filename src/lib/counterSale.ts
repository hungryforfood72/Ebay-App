import type { CounterSale, Item } from "@/generated/prisma/client";
import { NextResponse } from "next/server";
import { AuthError } from "./auth";
import { parseBundleComponentUnits } from "./itemUnits";
import { prisma } from "./prisma";
import { getShopifyConfig, shopifyGraphql, throwOnUserErrors, type UserError } from "./shopify";
import { getWalkupSaleSettings, ItemSaleError, manifestLinePrices, recordItemSale } from "./walkupSale";
import { normalizeCode } from "./warehouse/codes";

// ---------------------------------------------------------------------------
// Walk-up and shelf sales from the scan page, with checks (Cristian,
// 2026-10-21: more people will have scanners). The price to get is the
// ideal price. Two things need proof, enforced here so the page can't skip
// them:
//   - "Expiring soon" (the cheaper near-expiry price): a photo of the date.
//   - Charging less than the app allows (ideal, or near-expiry when
//     ticked): a photo and a reason.
// Every sale gets a CounterSale row (who, what, price vs ideal, photos,
// reason, payment) for the owner's In-person sales page.
//
// Payment: cash (sold right away), or a Shopify invoice from the Epic
// Steals store: a draft order with the item as a custom line (so Shopify's
// own stock and the order sync leave it alone; this app records the sale),
// no shipping (local pickup), tagged IN_PERSON_TAG, emailed to the
// customer. Stock only comes off once Shopify says it's paid, checked by
// the seller's screen, the owner's page and the 10-minute cron. Then the
// Shopify order is marked fulfilled (they walked out with it).
// ---------------------------------------------------------------------------

export const IN_PERSON_TAG = "in-person-sale";
const MAX_PHOTOS = 6;
// Invoices still unpaid after this long stop being checked automatically;
// the owner's page still shows them.
const SETTLE_DAYS = 14;

export class CounterSaleError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CounterSaleError";
    this.status = status;
  }
}

// The JSON error answer for the counter-sale routes.
export function counterSaleError(e: unknown) {
  if (e instanceof CounterSaleError || e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[counter-sales]", e);
  return NextResponse.json({ error: e instanceof Error ? e.message : "Something went wrong." }, { status: 500 });
}

export type SaleTarget = {
  kind: "walkup" | "shelf";
  // Walk-up: the manifest being worked. Shelf: not needed.
  manifestId: string | null;
  // An already-listed Item (shelf sales always; walk-ups when "already
  // inventoried"). null = a walk-up straight off the manifest.
  itemId: string | null;
  // What was scanned: a UPC, or for a shelf sale the item's ES label.
  upc: string;
  binCode?: string | null;
};

// The prices a sale is checked against, in the unit it's sold in: per
// physical unit off the manifest, per listing unit (a pack, a bundle) for
// a listed item. null = nothing to compare against.
export type SaleQuote = {
  description: string;
  packSize: number | null;
  ideal: number | null;
  nearExpiry: number | null;
  // manifest: the walk-up tiers from the manifest line. listed: the item's
  // own listed price (no manifest line), near-expiry at the same ratio the
  // tiers use.
  source: "manifest" | "listed" | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

async function findItem(target: SaleTarget): Promise<Item> {
  const item = await prisma.item.findUnique({ where: { id: target.itemId! } });
  if (!item) throw new CounterSaleError("That item isn't in the app anymore.", 404);
  const code = target.upc.trim();
  const matches =
    target.kind === "walkup"
      ? item.manifestId === target.manifestId && item.upc === code
      : normalizeCode(code) === item.sku.toUpperCase() ||
        (item.isBundle
          ? parseBundleComponentUnits(item.bundleComponents).some((c) => c.upc === code)
          : item.upc === code);
  if (!matches) throw new CounterSaleError("That item doesn't match what was scanned. Scan it again.");
  return item;
}

export async function quoteSale(target: SaleTarget): Promise<SaleQuote & { item: Item | null }> {
  const upc = target.upc.trim();
  if (!upc) throw new CounterSaleError("Scan the item first.");
  if (!target.itemId) {
    if (target.kind !== "walkup" || !target.manifestId) throw new CounterSaleError("Pick the item again.");
    const line = await manifestLinePrices(target.manifestId, upc);
    if (!line) throw new CounterSaleError("No line on this manifest matches that UPC.", 404);
    return {
      description: line.description,
      packSize: null,
      ideal: round2(line.idealPrice),
      nearExpiry: round2(line.nearExpiryPrice),
      source: "manifest",
      item: null,
    };
  }
  const item = await findItem(target);
  const description = item.finalTitle ?? item.aiTitle ?? "Untitled item";
  const pack = !item.isBundle && item.isMultipack && item.packSize && item.packSize > 1 ? item.packSize : 1;
  if (!item.isBundle && item.manifestId && item.upc) {
    const line = await manifestLinePrices(item.manifestId, item.upc);
    if (line) {
      return {
        description,
        packSize: pack > 1 ? pack : null,
        ideal: round2(line.idealPrice * pack),
        nearExpiry: round2(line.nearExpiryPrice * pack),
        source: "manifest",
        item,
      };
    }
  }
  const listed = item.price != null ? Number(item.price) : null;
  if (listed == null || listed <= 0) return { description, packSize: pack > 1 ? pack : null, ideal: null, nearExpiry: null, source: null, item };
  const s = await getWalkupSaleSettings();
  return {
    description,
    packSize: pack > 1 ? pack : null,
    ideal: round2(listed),
    nearExpiry: round2((listed * s.nearExpiryRetailPct) / s.idealRetailPct),
    source: "listed",
    item,
  };
}

function isPhotoUrl(u: unknown): u is string {
  return typeof u === "string" && u.length < 500 && u.startsWith("https://res.cloudinary.com/");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NewSale = {
  target: SaleTarget;
  quantity: number;
  pricePerUnit: number;
  nearExpiry: boolean;
  photoUrls: unknown[];
  reason: string | null;
  payment: "cash" | "invoice";
  email: string | null;
};

export async function createCounterSale(input: NewSale, soldBy: string | null): Promise<CounterSale> {
  const quantity = Math.round(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 1) throw new CounterSaleError("Enter a quantity of at least 1.");
  const price = round2(input.pricePerUnit);
  if (!Number.isFinite(price) || price <= 0) throw new CounterSaleError("Enter a price.");
  const photoUrls = input.photoUrls.filter(isPhotoUrl).slice(0, MAX_PHOTOS);
  const reason = input.reason?.trim().slice(0, 500) || null;

  const quote = await quoteSale(input.target);
  const allowed = input.nearExpiry ? quote.nearExpiry : quote.ideal;
  const belowAsked = allowed != null && price < allowed - 0.005;
  if (input.nearExpiry && photoUrls.length === 0) {
    throw new CounterSaleError("Expiring soon needs a photo of the date on the item.");
  }
  if (belowAsked && photoUrls.length === 0) {
    throw new CounterSaleError(`Under the $${allowed!.toFixed(2)} price: take a photo of the item.`);
  }
  if (belowAsked && (!reason || reason.length < 3)) {
    throw new CounterSaleError(`Under the $${allowed!.toFixed(2)} price: say why it's lower.`);
  }

  if (quote.item) {
    const available = Math.max(0, quote.item.quantity - quote.item.soldQuantity);
    if (quantity > available) throw new CounterSaleError(`Only ${available} left on this listing.`);
  }

  let email: string | null = null;
  if (input.payment === "invoice") {
    email = input.email?.trim().toLowerCase() ?? "";
    if (!EMAIL_RE.test(email)) throw new CounterSaleError("Enter the customer's email for the invoice.");
    if (!getShopifyConfig()) throw new CounterSaleError("Shopify isn't connected, so invoices can't be sent. Take cash.", 503);
  }

  const base = {
    kind: input.target.kind,
    manifestId: quote.item?.manifestId ?? input.target.manifestId,
    itemId: quote.item?.id ?? null,
    upc: input.target.upc.trim(),
    binCode: input.target.binCode?.trim() || null,
    description: quote.description.slice(0, 300),
    quantity,
    packSize: quote.packSize,
    pricePerUnit: price,
    idealPricePerUnit: quote.ideal,
    allowedPricePerUnit: allowed,
    nearExpiry: input.nearExpiry,
    belowAsked,
    reason,
    photoUrls,
    soldBy,
  };

  if (input.payment === "cash") {
    const links = await recordStock({ ...base, payment: "cash", shopifyOrderName: null });
    return prisma.counterSale.create({
      data: { ...base, payment: "cash", status: "sold", completedAt: new Date(), ...links },
    });
  }

  const sale = await prisma.counterSale.create({
    data: { ...base, payment: "invoice", customerEmail: email, status: "awaiting_payment" },
  });
  try {
    const draft = await createInvoice(sale);
    return await prisma.counterSale.update({
      where: { id: sale.id },
      data: { shopifyDraftOrderId: draft.id, invoiceUrl: draft.invoiceUrl },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.counterSale.update({ where: { id: sale.id }, data: { status: "failed", error: `Invoice: ${message}`.slice(0, 1000) } });
    throw new CounterSaleError(`Couldn't send the invoice: ${message}`, 502);
  }
}

// Takes the units off: a walk-up straight off the manifest is a
// ManifestWalkupSale; a listed item goes through recordItemSale (eBay
// quantity, InPersonSale, bins).
type StockSale = {
  kind: string;
  manifestId: string | null;
  itemId: string | null;
  upc: string | null;
  binCode: string | null;
  quantity: number;
  pricePerUnit: number | CounterSale["pricePerUnit"];
  soldBy: string | null;
  payment: string;
  shopifyOrderName: string | null;
};

async function recordStock(s: StockSale): Promise<{ inPersonSaleId?: string; walkupSaleId?: string }> {
  const price = Number(s.pricePerUnit);
  const paid = s.payment === "invoice" ? `Shopify invoice${s.shopifyOrderName ? ` ${s.shopifyOrderName}` : ""}` : "cash";
  const label = s.kind === "walkup" ? "Walk-up sale" : "Shelf sale";
  const note = `${label} — ${s.quantity} unit(s) @ $${price.toFixed(2)} each, in person (${paid})`;
  if (!s.itemId) {
    const row = await prisma.manifestWalkupSale.create({
      data: { manifestId: s.manifestId!, upc: s.upc!, quantity: s.quantity, pricePerUnit: price, note, recordedBy: s.soldBy },
    });
    return { walkupSaleId: row.id };
  }
  const item = await prisma.item.findUnique({ where: { id: s.itemId } });
  if (!item) throw new CounterSaleError("That item isn't in the app anymore.", 404);
  try {
    const { adjustment } = await recordItemSale(item, {
      quantity: s.quantity,
      pricePerUnit: price,
      note,
      recordedBy: s.soldBy,
      binCode: s.binCode,
    });
    const ips = await prisma.inPersonSale.findUnique({ where: { stockAdjustmentId: adjustment.id }, select: { id: true } });
    return { inPersonSaleId: ips?.id };
  } catch (e) {
    if (e instanceof ItemSaleError) throw new CounterSaleError(e.message, e.status);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Shopify invoice
// ---------------------------------------------------------------------------

async function createInvoice(sale: CounterSale): Promise<{ id: string; invoiceUrl: string | null }> {
  const money = (n: number) => ({ amount: n.toFixed(2), currencyCode: "USD" });
  const unit = sale.packSize ? ` (pack of ${sale.packSize})` : "";
  const created = await shopifyGraphql<{
    draftOrderCreate: { draftOrder: { id: string; invoiceUrl: string | null } | null; userErrors: UserError[] };
  }>(
    `mutation($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) { draftOrder { id invoiceUrl } userErrors { field message } }
    }`,
    {
      input: {
        email: sale.customerEmail,
        tags: [IN_PERSON_TAG],
        note: `In-person sale, picked up at the warehouse. Sold by ${sale.soldBy ?? "staff"}.`,
        lineItems: [
          {
            title: `${sale.description}${unit}`.slice(0, 255),
            quantity: sale.quantity,
            originalUnitPriceWithCurrency: money(Number(sale.pricePerUnit)),
            // Local pickup: nothing to ship, so checkout asks for no
            // address and charges no shipping. (A $0 "Local pickup"
            // shippingLine was tried: Shopify drops it when nothing
            // ships. Tested live 2026-10-21, shipping total $0.)
            requiresShipping: false,
          },
        ],
      },
    }
  );
  throwOnUserErrors("Shopify refused the invoice", created.draftOrderCreate.userErrors);
  const draft = created.draftOrderCreate.draftOrder;
  if (!draft) throw new Error("Shopify didn't create the invoice.");
  const sent = await shopifyGraphql<{ draftOrderInvoiceSend: { userErrors: UserError[] } }>(
    `mutation($id: ID!) { draftOrderInvoiceSend(id: $id) { draftOrder { id } userErrors { field message } } }`,
    { id: draft.id }
  );
  throwOnUserErrors("Shopify didn't email the invoice", sent.draftOrderInvoiceSend.userErrors);
  return draft;
}

export type InvoiceState = "awaiting_payment" | "payment_pending" | "sold" | "cancelled" | "failed";

// Checks one unpaid invoice with Shopify. Paid: records the sale (once,
// even if two checks land together) and fulfills the Shopify order.
export async function refreshInvoice(id: string): Promise<{ sale: CounterSale; state: InvoiceState }> {
  let sale = await prisma.counterSale.findUnique({ where: { id } });
  if (!sale) throw new CounterSaleError("That sale doesn't exist.", 404);
  if (sale.status !== "awaiting_payment" || !sale.shopifyDraftOrderId) return { sale, state: sale.status as InvoiceState };

  const data = await shopifyGraphql<{
    draftOrder: { status: string; order: { id: string; name: string; displayFinancialStatus: string | null } | null } | null;
  }>(`query($id: ID!) { draftOrder(id: $id) { status order { id name displayFinancialStatus } } }`, { id: sale.shopifyDraftOrderId });
  const draft = data.draftOrder;
  if (!draft) {
    // Deleted in Shopify admin.
    sale = await prisma.counterSale.update({ where: { id }, data: { status: "cancelled", error: "The invoice was deleted in Shopify." } });
    return { sale, state: "cancelled" };
  }
  const order = draft.order;
  if (!order) return { sale, state: "awaiting_payment" };
  if (order.displayFinancialStatus !== "PAID") {
    if (!sale.shopifyOrderId) {
      sale = await prisma.counterSale.update({ where: { id }, data: { shopifyOrderId: order.id, shopifyOrderName: order.name } });
    }
    return { sale, state: "payment_pending" };
  }

  // Claim it: only one check records the stock.
  const claimed = await prisma.counterSale.updateMany({
    where: { id, status: "awaiting_payment" },
    data: { status: "recording", shopifyOrderId: order.id, shopifyOrderName: order.name, paidAt: new Date() },
  });
  if (claimed.count === 0) {
    sale = (await prisma.counterSale.findUnique({ where: { id } }))!;
    return { sale, state: sale.status === "recording" ? "payment_pending" : (sale.status as InvoiceState) };
  }
  sale = (await prisma.counterSale.findUnique({ where: { id } }))!;
  try {
    const links = await recordStock(sale);
    let error: string | null = null;
    await fulfillOrder(order.id).catch((e) => {
      error = `Paid and recorded, but couldn't mark the Shopify order fulfilled: ${e instanceof Error ? e.message : String(e)}`;
    });
    sale = await prisma.counterSale.update({ where: { id }, data: { status: "sold", completedAt: new Date(), error, ...links } });
    return { sale, state: "sold" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sale = await prisma.counterSale.update({
      where: { id },
      data: { status: "failed", error: `Paid on Shopify, but the stock didn't update: ${message}`.slice(0, 1000) },
    });
    return { sale, state: "failed" };
  }
}

// They walked out with it, so the Shopify order is done. No email.
async function fulfillOrder(orderId: string): Promise<void> {
  const data = await shopifyGraphql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string }[] } } | null }>(
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`,
    { id: orderId }
  );
  const open = (data.order?.fulfillmentOrders.nodes ?? []).filter((f) => f.status === "OPEN" || f.status === "IN_PROGRESS");
  if (open.length === 0) return;
  const created = await shopifyGraphql<{ fulfillmentCreate: { userErrors: UserError[] } }>(
    `mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } } }`,
    { fulfillment: { lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })), notifyCustomer: false } }
  );
  throwOnUserErrors("Couldn't fulfill the order", created.fulfillmentCreate.userErrors);
}

// The customer didn't pay: the invoice goes away and nothing was sold.
export async function cancelInvoice(id: string, user: { username: string; role: string }): Promise<CounterSale> {
  const sale = await prisma.counterSale.findUnique({ where: { id } });
  if (!sale) throw new CounterSaleError("That sale doesn't exist.", 404);
  if (user.role !== "owner" && sale.soldBy !== user.username) throw new CounterSaleError("Only whoever made the sale (or the owner) can cancel it.", 403);
  if (sale.status !== "awaiting_payment") throw new CounterSaleError("That invoice isn't waiting for payment anymore.", 409);
  // Paid in the meantime? Then it's a sale, not a cancel.
  const fresh = await refreshInvoice(id);
  if (fresh.state !== "awaiting_payment") {
    throw new CounterSaleError(fresh.state === "sold" ? "It was just paid, so it's sold." : "Shopify already has an order for it. Check Shopify.", 409);
  }
  if (sale.shopifyDraftOrderId) {
    const deleted = await shopifyGraphql<{ draftOrderDelete: { userErrors: UserError[] } }>(
      `mutation($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { field message } } }`,
      { input: { id: sale.shopifyDraftOrderId } }
    );
    throwOnUserErrors("Couldn't delete the invoice in Shopify", deleted.draftOrderDelete.userErrors);
  }
  return prisma.counterSale.update({ where: { id }, data: { status: "cancelled" } });
}

// Every recent unpaid invoice, checked once. For the cron and the owner's
// page, so a paid invoice is recorded even if nobody was watching.
export async function settleOpenInvoices(): Promise<{ checked: number; sold: number; errors: string[] }> {
  if (!getShopifyConfig()) return { checked: 0, sold: 0, errors: [] };
  const open = await prisma.counterSale.findMany({
    where: { status: "awaiting_payment", createdAt: { gte: new Date(Date.now() - SETTLE_DAYS * 24 * 60 * 60 * 1000) } },
    select: { id: true },
  });
  let sold = 0;
  const errors: string[] = [];
  for (const s of open) {
    try {
      if ((await refreshInvoice(s.id)).state === "sold") sold++;
    } catch (e) {
      errors.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked: open.length, sold, errors };
}
