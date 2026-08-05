import { prisma } from "@/lib/prisma";
import { ItemStatus } from "@/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { randomUUID } from "node:crypto";
import { draftItem } from "@/lib/draftItem";
import { lookupCategoryForItem } from "@/lib/categoryLookup";

// Draft (up to 45s) + category lookup (up to 100s worst case) can together
// take a while — give the function room to actually finish that work in
// after(), not just respond to the initial POST.
export const maxDuration = 150;

// List items for the review queue, optionally filtered by status.
export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status");

  const items = await prisma.item.findMany({
    where: status ? { status: status as ItemStatus } : undefined,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(items);
}

// Save one scanned item. Called from the mobile scan flow after photos have
// already been uploaded to Cloudinary, so this is just metadata + URLs.
export async function POST(request: NextRequest) {
  const body = await request.json();

  const required = ["upc", "quantity", "shelfLocation"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      return NextResponse.json(
        { error: `Missing required field: ${field}` },
        { status: 400 }
      );
    }
  }

  // Prefix the SKU with the shelf location (e.g. "A6-<uuid>") so it's
  // recognizable at a glance on eBay's side, not just a bare UUID.
  const sku = `${String(body.shelfLocation).trim()}-${randomUUID()}`;

  const item = await prisma.item.create({
    data: {
      sku,
      upc: body.upc,
      quantity: Number(body.quantity),
      isMultipack: Boolean(body.isMultipack),
      packSize: body.isMultipack ? Number(body.packSize) : null,
      expirationDate: body.expirationDate ? new Date(body.expirationDate) : null,
      shelfLocation: body.shelfLocation,
      photoUrls: Array.isArray(body.photoUrls) ? body.photoUrls : [],
      scannedBy: body.scannedBy ?? null,
      scanSessionId: body.scanSessionId ?? null,
    },
  });

  // Run drafting + category lookup here, after responding, so it's fully
  // server-side and doesn't depend on the phone's browser tab staying in the
  // foreground. (An earlier version had the client fire these as separate
  // fetches instead — but the "+ Photo" button launches the native camera
  // app via capture="environment", which backgrounds the tab almost
  // immediately during real scanning, and mobile browsers suspend
  // backgrounded network activity — very likely killing those requests
  // mid-flight before the ~45-100s of work finished.) Category lookup runs
  // after drafting so it has a real title to search from, not just the UPC.
  after(async () => {
    try {
      await draftItem(item.id);
    } catch (e) {
      console.error(`[items after()] ${item.id}: draft failed`, e);
      return;
    }
    try {
      await lookupCategoryForItem(item.id);
    } catch (e) {
      console.error(`[items after()] ${item.id}: category lookup failed`, e);
    }
  });

  return NextResponse.json(item, { status: 201 });
}
