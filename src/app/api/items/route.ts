import { prisma } from "@/lib/prisma";
import { ItemStatus } from "@/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { draftItem } from "@/lib/draftItem";
import { lookupCategoryForItem } from "@/lib/categoryLookup";

// Background draft (SDK-bounded to 45s) then category lookup (SDK-bounded
// to 55s) run sequentially in after() below — 120s gives both room to hit
// their own timeouts and still return cleanly instead of getting killed by
// the platform mid-request.
export const maxDuration = 120;

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

  const item = await prisma.item.create({
    data: {
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

  // Draft the title/description and look up the category in the background
  // — the scan flow gets its response immediately so the phone isn't stuck
  // waiting, this keeps running after that. Category search runs after the
  // draft so it has a real title to search from, not just the bare UPC.
  after(async () => {
    console.log(`[background] ${item.id}: starting draft`);
    try {
      await draftItem(item.id);
      console.log(`[background] ${item.id}: draft done`);
    } catch (e) {
      console.error(`[background] ${item.id}: draft failed`, e);
    }
    console.log(`[background] ${item.id}: starting category lookup`);
    try {
      await lookupCategoryForItem(item.id);
      console.log(`[background] ${item.id}: category lookup done`);
    } catch (e) {
      console.error(`[background] ${item.id}: category lookup failed`, e);
    }
  });

  return NextResponse.json(item, { status: 201 });
}
