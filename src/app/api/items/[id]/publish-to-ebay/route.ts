import {
  createOffer,
  createOrReplaceInventoryItem,
  EbayApiError,
  getEbayEnvironment,
  publishOffer,
  toEbaySku,
  toItemForEbayPublish,
} from "@/lib/ebay";
import { tryFixMissingAspect } from "@/lib/publishRemediation";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import type { Item } from "@/generated/prisma/client";

// Auto-remediation (tryFixMissingAspect) needs its own web-search call on
// top of the real eBay round-trips below — 60s was already tight for just
// those.
export const maxDuration = 90;

async function attemptPublish(id: string, item: Item): Promise<{ listingId: string }> {
  const publishData = toItemForEbayPublish(item);
  // Always re-pushed, not just on the very first attempt — a retry (manual
  // edit, or the auto-fix below) that changed price/title/specifics since
  // the offer was first created needs eBay's inventory item to actually
  // reflect that before publishing again. The old "only on first attempt"
  // gate meant a fixed item specific would never actually reach eBay on
  // retry — publishOffer would just fail the exact same way a second time.
  await createOrReplaceInventoryItem(publishData);

  let offerId = item.ebayOfferId;
  if (!offerId) {
    offerId = await createOffer(publishData);
    // ebaySku is persisted here (not just computed on the fly) so a later
    // eBay order's line-item sku can be matched back to this Item via an
    // indexed exact lookup — see the field's schema comment.
    await prisma.item.update({
      where: { id },
      data: { ebayOfferId: offerId, ebaySku: toEbaySku(item.sku) },
    });
  }
  const listingId = await publishOffer(offerId);
  return { listingId };
}

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

  try {
    let result;
    try {
      result = await attemptPublish(id, item);
    } catch (e) {
      const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Publish failed.";
      // eBay rejected over a missing required item specific (e.g. "Dosage")
      // — look up the real value and retry exactly once. Any other failure
      // (or a remediation attempt that couldn't find a confident value)
      // falls straight through to the outer catch, unchanged from before.
      const fixed = await tryFixMissingAspect(id, message);
      if (!fixed) throw e;
      const refreshedItem = await prisma.item.findUniqueOrThrow({ where: { id } });
      result = await attemptPublish(id, refreshedItem);
    }
    const updated = await prisma.item.update({
      where: { id },
      data: {
        status: "listed",
        ebayListingId: result.listingId,
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
