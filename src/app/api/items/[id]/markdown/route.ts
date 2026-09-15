import { createMarkdownPromotion, deleteMarkdownPromotion, EbayApiError } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const MAX_DURATION_DAYS = 14;

function parsePercentOff(body: unknown): number | null {
  const value = Number((body as { percentOff?: unknown })?.percentOff);
  return Number.isFinite(value) && value >= 1 && value <= 80 ? value : null;
}

// Starts an eBay "Sale event" (Discounts Manager) on one item — shows a
// strikethrough "was $X" price next to the new discounted price, unlike
// /api/items/[id]/discount which just silently changes the listed price.
// Deliberately its own explicit action, same "human decides, app just
// executes" philosophy as publish-to-ebay/promote.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const percentOff = parsePercentOff(await request.json().catch(() => ({})));
  if (percentOff == null) {
    return NextResponse.json({ error: "A discount percentage between 1 and 80 is required." }, { status: 400 });
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayListingId) {
    return NextResponse.json({ error: "This item must be published to eBay before starting a sale event." }, { status: 400 });
  }
  if (item.ebayMarkdownId) {
    return NextResponse.json({ error: "Already has an active sale event — stop it first to change the discount." }, { status: 400 });
  }
  if (!item.photoUrls[0]) {
    return NextResponse.json({ error: "This item needs at least one photo before starting a sale event." }, { status: 400 });
  }

  // Run until the item's own expiration if that's sooner than the usual
  // cap (14 days) — no point running a sale past the point the listing
  // itself is expected to be gone.
  const maxEnd = new Date(Date.now() + MAX_DURATION_DAYS * 24 * 60 * 60 * 1000);
  const endDate = item.expirationDate && item.expirationDate > new Date() && item.expirationDate < maxEnd
    ? item.expirationDate
    : maxEnd;

  try {
    // Confirmed live: eBay caps this at 50 characters.
    const description = `${percentOff}% off for a limited time!`.slice(0, 50);
    const promotion = await createMarkdownPromotion(item.ebayListingId, percentOff, endDate, description, item.photoUrls[0]);
    const updated = await prisma.item.update({
      where: { id },
      data: {
        ebayMarkdownId: promotion.promotionId,
        markdownPercentOff: percentOff,
        markdownStartedAt: new Date(promotion.startDate),
        markdownEndsAt: new Date(promotion.endDate),
        ebayMarkdownError: null,
      },
    });
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Starting the sale event failed.";
    await prisma.item.update({ where: { id }, data: { ebayMarkdownError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// Ends a sale event early — the listing itself stays live, only the
// strikethrough markdown is removed.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayMarkdownId) {
    return NextResponse.json({ error: "This item doesn't have an active sale event." }, { status: 400 });
  }

  try {
    await deleteMarkdownPromotion(item.ebayMarkdownId);
    const updated = await prisma.item.update({
      where: { id },
      data: { ebayMarkdownId: null, markdownPercentOff: null, markdownStartedAt: null, markdownEndsAt: null, ebayMarkdownError: null },
    });
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Stopping the sale event failed.";
    await prisma.item.update({ where: { id }, data: { ebayMarkdownError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
