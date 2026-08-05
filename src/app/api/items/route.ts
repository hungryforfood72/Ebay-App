import { prisma } from "@/lib/prisma";
import { ItemStatus } from "@/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";

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

  // Drafting + category lookup are triggered by the client right after this
  // responds (see scan/page.tsx) rather than run here via Next's after() —
  // that relied on Vercel keeping this function alive past the response,
  // which wasn't reliably completing in production. Triggering as separate
  // requests means each one is its own top-level invocation with its own
  // timeout, and — importantly — it's actually observable (network tab,
  // logs) instead of a silent background failure with no client-visible
  // evidence. The work itself still runs entirely server-side either way.
  return NextResponse.json(item, { status: 201 });
}
