import { prisma } from "@/lib/prisma";
import { getShopifyConfig } from "@/lib/shopify";
import { publishItemToShopify } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// The review page's Publish button for a Shopify & Whatnot only item (see
// Item.shopifyOnly): the same explicit "make it live" step as
// publish-to-eBay, just to the Shopify store, which feeds Whatnot. Flips
// the item to "listed" once it's on the store's channels.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getShopifyConfig()) {
    return NextResponse.json({ error: "The Shopify store isn't connected yet (Settings)." }, { status: 400 });
  }
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) return NextResponse.json({ error: "Item not found." }, { status: 404 });
  if (!item.shopifyOnly) {
    return NextResponse.json({ error: "This item is set to list on eBay, not Shopify only." }, { status: 400 });
  }
  if (item.status !== "ready") {
    return NextResponse.json({ error: "Mark it ready in review first." }, { status: 400 });
  }

  // Same bar as publish-to-eBay: a Shopify product needs these as much.
  const missing: string[] = [];
  if (!item.finalTitle) missing.push("title");
  if (item.price == null) missing.push("price");
  if (!item.categoryId) missing.push("category");
  if (!item.condition) missing.push("condition");
  if (!item.weightLbs && !item.weightOz) missing.push("weight (Shopify works out the buyer's shipping from it)");
  if (item.photoUrls.length === 0) missing.push("at least one photo");
  if (item.localPickupOnly) missing.push("shipping (local-pickup-only items stay off Shopify)");
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing ${missing.join(", ")} before this can be published.` }, { status: 400 });
  }

  try {
    const outcome = await publishItemToShopify(id, { fromReview: true });
    if (outcome === "nothing_left") {
      return NextResponse.json({ error: "There's no stock left on this item to sell." }, { status: 400 });
    }
    if (outcome === "not_eligible") {
      return NextResponse.json({ error: "This item can't go to Shopify right now." }, { status: 400 });
    }
    return NextResponse.json(await prisma.item.findUnique({ where: { id } }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Publish failed." }, { status: 502 });
  }
}
