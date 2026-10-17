import { Prisma } from "@/generated/prisma/client";
import { normalizeBreakdown } from "@/lib/expirationBreakdown";
import { prisma } from "@/lib/prisma";
import { AuthError, requireOwner } from "@/lib/auth";
import { binGateError } from "@/lib/warehouse/binGate";
import { NextRequest, NextResponse } from "next/server";

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
] as const;

// Update review-step fields on an item (title/description/price/status, etc).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const data: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in body) data[field] = body[field];
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
  if ("shopifyOnly" in data) {
    const current = await prisma.item.findUnique({
      where: { id },
      select: { ebayOfferId: true, ebayListingId: true, shopifyPublishedAt: true },
    });
    if (current && (current.ebayOfferId || current.ebayListingId || current.shopifyPublishedAt)) {
      return NextResponse.json({ error: "This item is already live, so it can't switch stores now." }, { status: 400 });
    }
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

  const item = await prisma.item.update({ where: { id }, data });

  return NextResponse.json(item);
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
  await prisma.item.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
