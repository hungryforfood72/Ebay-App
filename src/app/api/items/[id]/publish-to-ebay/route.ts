import {
  createOffer,
  createOrReplaceInventoryItem,
  EbayApiError,
  getEbayEnvironment,
  publishOffer,
  toEbaySku,
} from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// Publishes one item live via the real eBay Inventory API. Deliberately its
// own explicit action, separate from "Mark ready" — Cristian reviews every
// field by hand on the review page already; this button is the second,
// distinct decision to actually make it live, since publishOffer isn't
// cleanly undoable from inside this app.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }

  // Server-side belt-and-suspenders, same reasoning as the CSV export
  // route's exportableItems filter — a past real upload failure taught the
  // team client-side gating alone isn't enough to trust.
  const missing: string[] = [];
  if (!item.finalTitle) missing.push("title");
  if (item.price == null) missing.push("price");
  if (!item.categoryId) missing.push("category");
  if (!item.condition) missing.push("condition");
  if (!item.weightLbs && !item.weightOz) missing.push("weight");
  if (item.photoUrls.length === 0) missing.push("at least one photo");
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing ${missing.join(", ")} before this can be published.` },
      { status: 400 }
    );
  }

  const publishData = {
    sku: item.sku,
    finalTitle: item.finalTitle!,
    finalDescription: item.finalDescription ?? "",
    price: Number(item.price),
    categoryId: item.categoryId!,
    condition: item.condition!,
    itemSpecifics: item.itemSpecifics as Record<string, string> | null,
    photoUrls: item.photoUrls,
    quantity: item.quantity,
    weightLbs: item.weightLbs,
    weightOz: item.weightOz,
    upc: item.upc,
  };

  try {
    // ebayOfferId is checked first so a retry after a publish failure skips
    // straight to publishing the existing offer instead of creating a
    // second one for the same SKU, which eBay rejects outright.
    let offerId = item.ebayOfferId;
    if (!offerId) {
      await createOrReplaceInventoryItem(publishData);
      offerId = await createOffer(publishData);
      // ebaySku is persisted here (not just computed on the fly) so a
      // later eBay order's line-item sku can be matched back to this Item
      // via an indexed exact lookup — see the field's schema comment.
      await prisma.item.update({
        where: { id },
        data: { ebayOfferId: offerId, ebaySku: toEbaySku(item.sku) },
      });
    }
    const listingId = await publishOffer(offerId);
    const updated = await prisma.item.update({
      where: { id },
      data: {
        status: "listed",
        ebayListingId: listingId,
        ebayPublishedAt: new Date(),
        ebayPublishError: null,
        ebayEnvironment: getEbayEnvironment(),
      },
    });
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Publish failed.";
    await prisma.item.update({ where: { id }, data: { ebayPublishError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
