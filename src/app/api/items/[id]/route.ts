import { forViewer } from "@/lib/itemView";
import { changedFields, logActivity } from "@/lib/activityLog";
import { Prisma } from "@/generated/prisma/client";
import { normalizeBreakdown } from "@/lib/expirationBreakdown";
import { prisma } from "@/lib/prisma";
import { AuthError, getRequestUser, requireOwner, requireUser } from "@/lib/auth";
import { PUBLISH_STALE_MS } from "@/lib/publishLock";
import { binGateError } from "@/lib/warehouse/binGate";
import { BARCODE_MISMATCH_CLEARED, barcodeMismatchBlocks } from "@/lib/barcodeMismatch";
import { fillCategorySpecifics } from "@/lib/categorySpecifics";
import { getWhatnotStartPrice } from "@/lib/shopifySync";
import { after, NextRequest, NextResponse } from "next/server";

const EDITABLE_FIELDS = [
  "finalTitle",
  "finalDescription",
  "price",
  "categoryId",
  "condition",
  "compNotes",
  "status",
  "reviewedBy",
  "itemSpecifics",
  "chargeForShipping",
  "boxSize",
  "weightLbs",
  "weightOz",
  "expirationDate",
  "localPickupOnly",
  "shopifyOnly",
  "whatnotOnly",
] as const;

// Update review-step fields on an item (title/description/price/status, etc).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireUser(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const body = await request.json();

  const data: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in body) data[field] = body[field];
  }
  const current = await prisma.item.findUnique({
    where: { id },
    select: {
      status: true,
      ebayOfferId: true,
      ebayListingId: true,
      ebaySku: true,
      ebayPublishedAt: true,
      shopifyPublishedAt: true,
      shopifyProductId: true,
      whatnotOnly: true,
      publishStartedAt: true,
      barcodeMismatch: true,
    },
  });
  if (!current) return NextResponse.json({ error: "That item doesn't exist anymore." }, { status: 404 });
  // "The barcode is right" on Review: the owner only, since a wrong scan
  // throws off the load's counts. Only clearing; the draft sets it.
  if (typeof body.barcodeMismatch === "string" && body.barcodeMismatch.startsWith(BARCODE_MISMATCH_CLEARED)) {
    const user = getRequestUser(request);
    if (user?.role !== "owner") {
      return NextResponse.json({ error: "Only Cristian can say the barcode is right." }, { status: 403 });
    }
    data.barcodeMismatch = `${BARCODE_MISMATCH_CLEARED} by ${user.username} on the Review page`;
  }
  if (data.status === "ready" && barcodeMismatchBlocks(current.barcodeMismatch) && !("barcodeMismatch" in data)) {
    return NextResponse.json({ error: `The photos don't match the barcode: ${current.barcodeMismatch}` }, { status: 400 });
  }
  const inReview = current.status === "pending_review" || current.status === "ready";
  const live = Boolean(current.ebayOfferId || current.ebayListingId || current.shopifyPublishedAt);
  // Review only ever moves an item between these two, and only an item
  // that's still in review: going live is the Publish buttons' job (a
  // "listed" off-eBay item would go up on the next sync without one), and
  // a live/exported/sold item moved back would reopen the store switch.
  if ("status" in data && ((data.status !== "pending_review" && data.status !== "ready") || !inReview)) {
    return NextResponse.json({ error: "Status can only be set to in review or ready here, on an item still in review." }, { status: 400 });
  }
  // A live item's price only changes through the owner (the 10-minute
  // sync copies Item.price to the store; eBay changes go through the
  // discount and sale routes).
  if ("price" in data && live && getRequestUser(request)?.role !== "owner") {
    return NextResponse.json({ error: "Only Cristian can change the price of a live listing." }, { status: 403 });
  }
  if ("price" in data && data.price !== null && data.price !== "") {
    const p = Number(data.price);
    if (!Number.isFinite(p) || p < 0.01 || p >= 100000) {
      return NextResponse.json({ error: "Price has to be at least $0.01." }, { status: 400 });
    }
    data.price = Math.round(p * 100) / 100;
  } else if ("price" in data) {
    data.price = null;
  }
  // "Not Rx only" on the Review page: the draft thought the package said Rx
  // Only and it doesn't. Only clearing it; the draft is what sets it. The
  // note keeps a regenerate from setting it again (draftItem.ts).
  if (body.rxOnly === false) {
    data.rxOnly = false;
    data.rxOnlyNote = "Cleared on the Review page";
  }
  if ("expirationDate" in data) {
    const value = data.expirationDate;
    const date = typeof value === "string" && value ? new Date(value) : null;
    if (date && Number.isNaN(date.getTime())) {
      return NextResponse.json({ error: "That expiration date isn't a real date." }, { status: 400 });
    }
    data.expirationDate = date;
    // A date typed on the review page replaces a multi-date breakdown from
    // the scan, unless it's just the breakdown's own earliest date again.
    const current = await prisma.item.findUnique({ where: { id }, select: { expirationBreakdown: true } });
    const breakdown = current ? normalizeBreakdown(current.expirationBreakdown) : null;
    if (breakdown && breakdown[0].date !== date?.toISOString().slice(0, 10)) {
      data.expirationBreakdown = Prisma.DbNull;
    }
  }
  // Switching stores is only for items not live anywhere yet: an eBay
  // listing can't become Shopify-only (or the other way) after the fact.
  // Three lanes (Cristian, 2026-11-04): eBay + Shopify, Shopify only, and
  // Whatnot only, which is always off eBay too (shopifyOnly).
  const laneSwitch = "shopifyOnly" in data || "whatnotOnly" in data;
  if (laneSwitch) {
    if (live || current.ebaySku || current.ebayPublishedAt) {
      return NextResponse.json({ error: "This item is already live, so it can't switch stores now." }, { status: 400 });
    }
    // A product from a half-finished publish carries this lane's price and
    // channels; switching would reuse it somewhere else.
    if (current.shopifyProductId) {
      return NextResponse.json(
        { error: "It already has a Shopify product from an earlier publish try, so it can't switch stores. Publish it as is, or delete it and scan again." },
        { status: 400 }
      );
    }
    // Only before it's live: an exported CSV item can't change lanes either.
    if (!inReview) {
      return NextResponse.json({ error: "Only items still in review can switch stores." }, { status: 400 });
    }
    if ("shopifyOnly" in data) data.shopifyOnly = data.shopifyOnly === true;
    if ("whatnotOnly" in data) data.whatnotOnly = data.whatnotOnly === true;
    if (data.whatnotOnly === true) data.shopifyOnly = true;
    if (data.shopifyOnly === false) data.whatnotOnly = false;
    // Out of Whatnot = not a giveaway any more either (giveaways are only
    // ever made on the List page, never switched into).
    if (data.whatnotOnly === false) data.whatnotGiveaway = false;
    // Into or out of Whatnot once it's in a bin: it would sit in the wrong
    // kind of bin, since Whatnot-only items live only in Whatnot bins and
    // nothing else does (Cristian, 2026-11-06: block it; the List page's
    // "List it for Whatnot" decides it before binning).
    if (data.whatnotOnly !== undefined && data.whatnotOnly !== current.whatnotOnly) {
      if ((await prisma.binContent.count({ where: { itemId: id } })) > 0) {
        return NextResponse.json(
          {
            error: current.whatnotOnly
              ? "It's already in a Whatnot bin, so it can't switch to eBay or Shopify now."
              : "It's already in a bin, so it can't switch to Whatnot now. Whatnot listings are decided on the List page, before binning.",
          },
          { status: 400 }
        );
      }
    }
    // The price follows the lane unless one was sent with it: into Whatnot
    // it's the auction start; out of Whatnot it's cleared, so a $1 start
    // can never go up on eBay or the store by mistake.
    if (!("price" in body)) {
      if (data.whatnotOnly === true && !current.whatnotOnly) {
        data.price = await getWhatnotStartPrice();
        data.originalPrice = null;
      } else if (data.whatnotOnly === false && current.whatnotOnly) {
        data.price = null;
        data.originalPrice = null;
      }
    }
  }
  // "Check the price" is done once Cristian saves a price on Review (an
  // employee typing one doesn't count). The activity log keeps what it said.
  if (
    "price" in data &&
    data.price != null &&
    data.price !== "" &&
    getRequestUser(request)?.role === "owner" &&
    (await prisma.item.count({ where: { id, priceCheck: { not: Prisma.DbNull } } })) > 0
  ) {
    data.priceCheck = Prisma.DbNull;
  }
  if ("status" in data && data.status === "ready") {
    // Warehouse items stay in review until every unit is in a bin
    // (src/lib/warehouse/binGate.ts).
    const current = await prisma.item.findUnique({
      where: { id },
      select: { id: true, sku: true, quantity: true, soldQuantity: true },
    });
    const binError = current ? await binGateError(current) : null;
    if (binError) return NextResponse.json({ error: binError }, { status: 400 });
    data.reviewedAt = new Date();
  }

  const before = await prisma.item.findUnique({ where: { id } });
  if (laneSwitch) {
    // One conditional write, so a publish that started (or went live)
    // since the checks above can't end up with the other lane's price.
    const { count } = await prisma.item.updateMany({
      where: {
        id,
        ebayOfferId: null,
        ebayListingId: null,
        ebaySku: null,
        shopifyPublishedAt: null,
        shopifyProductId: null,
        status: { in: ["pending_review", "ready"] },
        OR: [{ publishStartedAt: null }, { publishStartedAt: { lt: new Date(Date.now() - PUBLISH_STALE_MS) } }],
      },
      data,
    });
    if (count === 0) {
      return NextResponse.json(
        { error: "It's publishing or already live, so it can't switch stores now. Refresh the page." },
        { status: 409 }
      );
    }
  }
  const item = laneSwitch
    ? await prisma.item.findUniqueOrThrow({ where: { id } })
    : await prisma.item.update({ where: { id }, data });
  const change = before ? changedFields(before as unknown as Record<string, unknown>, Object.fromEntries(Object.keys(data).map((k) => [k, (item as unknown as Record<string, unknown>)[k]]))) : null;
  if (change) {
    const fields = Object.keys(change.after);
    const priceNote = "price" in change.after ? ` (price $${change.before.price ?? "none"} -> $${change.after.price})` : "";
    await logActivity({ request }, {
      action: "item.edit",
      summary: `Edited ${fields.join(", ")}${priceNote} on ${item.finalTitle ?? item.sku}`,
      targetType: "item",
      targetId: id,
      ...change,
    });
  }
  // Picked a different category on Review: it can recommend different
  // specifics (categorySpecifics.ts). After the response, so the save
  // isn't held up by the AI call.
  if (change && "categoryId" in change.after && item.categoryId) {
    after(async () => {
      try {
        await fillCategorySpecifics(id);
      } catch (e) {
        console.error(`[items PATCH] ${id}: category specifics failed`, e);
      }
    });
  }

  return NextResponse.json(forViewer(request, item));
}

// Delete an item (e.g. a scan mistake or duplicate). Only removes the
// database record — any Cloudinary photos it referenced are left as-is.
// Owner-only — Cristian's explicit "deleting records" restriction.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const before = await prisma.item.findUnique({
    where: { id },
    select: { sku: true, upc: true, finalTitle: true, price: true, quantity: true, soldQuantity: true, status: true, manifestId: true, ebayListingId: true, shopifyProductId: true, createdAt: true },
  });
  await prisma.item.delete({ where: { id } });
  await logActivity({ request }, { action: "item.delete", summary: `Deleted ${before?.finalTitle ?? before?.sku ?? id}`, targetType: "item", targetId: id, before });
  return NextResponse.json({ ok: true });
}
