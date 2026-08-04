import { prisma } from "@/lib/prisma";
import { ItemStatus } from "@/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { draftItem } from "@/lib/draftItem";
import { lookupCategoryForItem } from "@/lib/categoryLookup";

// Web search + Opus latency for the background draft/category work below
// can run well past a minute — give the function room so `after()` isn't
// cut off mid-work.
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
    try {
      await draftItem(item.id);
    } catch (e) {
      console.error(`Background draft failed for item ${item.id}:`, e);
    }
    try {
      await lookupCategoryForItem(item.id);
    } catch (e) {
      console.error(`Background category lookup failed for item ${item.id}:`, e);
    }
  });

  return NextResponse.json(item, { status: 201 });
}
