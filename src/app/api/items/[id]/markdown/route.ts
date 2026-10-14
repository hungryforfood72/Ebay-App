import { createMarkdownPromotion, EbayApiError, findMarkdownOnListing, stopMarkdownPromotion } from "@/lib/ebay";
import { ownerOnly } from "@/lib/auth";
import { MARKDOWN_SKIPPED_PREFIX } from "@/lib/markdownCheck";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const MAX_DURATION_DAYS = 14;
// An earlier sale ending within this long is one being wound down (ending a
// running sale moves its end 2 minutes out), so the new one waits for it.
// Anything longer is a real sale, e.g. one set up in Seller Hub.
const WIND_DOWN_MS = 15 * 60 * 1000;

function parsePercentOff(body: unknown): number | null {
  const value = Number((body as { percentOff?: unknown })?.percentOff);
  return Number.isFinite(value) && value >= 1 && value <= 80 ? value : null;
}

type SaleItem = NonNullable<Awaited<ReturnType<typeof prisma.item.findUnique>>>;

// Run until the item's own expiration if that's sooner than the usual cap
// (14 days) — no point running a sale past the point the listing itself is
// expected to be gone.
function defaultEndDate(item: SaleItem): Date {
  const maxEnd = new Date(Date.now() + MAX_DURATION_DAYS * 24 * 60 * 60 * 1000);
  return item.expirationDate && item.expirationDate > new Date() && item.expirationDate < maxEnd
    ? item.expirationDate
    : maxEnd;
}

// Creates the sale on eBay and records it. Shared by start and update, so
// both wait out a sale that's winding down: eBay skips a listing whose new
// sale overlaps an old one by even a minute, while still reporting the new
// sale as RUNNING.
async function startSale(item: SaleItem, percentOff: number, endDate: Date, failurePrefix = ""): Promise<NextResponse> {
  try {
    const existing = await findMarkdownOnListing(item.ebayListingId!);
    if (existing && existing.endDate.getTime() - Date.now() > WIND_DOWN_MS) {
      const message = `${failurePrefix}This listing is already in "${existing.name}" until ${existing.endDate.toLocaleDateString("en-US")}. End that one in Seller Hub first.`;
      // On an update the old sale is already gone, so the card needs to say so.
      if (failurePrefix) await prisma.item.update({ where: { id: item.id }, data: { ebayMarkdownError: message } });
      return NextResponse.json({ error: message }, { status: 400 });
    }
    // Confirmed live: eBay caps this at 50 characters.
    const description = `${percentOff}% off for a limited time!`.slice(0, 50);
    const promotion = await createMarkdownPromotion(
      item.ebayListingId!,
      percentOff,
      endDate,
      description,
      item.photoUrls[0],
      existing?.endDate
    );
    const updated = await prisma.item.update({
      where: { id: item.id },
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
    const message = failurePrefix + (e instanceof EbayApiError || e instanceof Error ? e.message : "Starting the sale event failed.");
    await prisma.item.update({ where: { id: item.id }, data: { ebayMarkdownError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// Starts an eBay "Sale event" (Discounts Manager) on one item — shows a
// strikethrough "was $X" price next to the new discounted price, unlike
// /api/items/[id]/discount which just silently changes the listed price.
// Deliberately its own explicit action, same "human decides, app just
// executes" philosophy as publish-to-ebay/promote.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
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
    return NextResponse.json({ error: "Already has a sale event. Use Update to change the discount." }, { status: 400 });
  }
  if (!item.photoUrls[0]) {
    return NextResponse.json({ error: "This item needs at least one photo before starting a sale event." }, { status: 400 });
  }
  return startSale(item, percentOff, defaultEndDate(item));
}

// Changes a sale's % off. eBay has no safe in-place edit we've verified, so
// this ends the current sale and starts the new one right after it's fully
// over (about 3 minutes at the regular price in between), keeping the same
// end date. Cristian did this by hand on 2026-10-13 (End, then Start a
// minute later) and the new sale was silently skipped; this is that, done
// in the right order.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const percentOff = parsePercentOff(await request.json().catch(() => ({})));
  if (percentOff == null) {
    return NextResponse.json({ error: "A discount percentage between 1 and 80 is required." }, { status: 400 });
  }

  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayListingId || !item.ebayMarkdownId) {
    return NextResponse.json({ error: "This item doesn't have a sale event to update." }, { status: 400 });
  }
  if (!item.photoUrls[0]) {
    return NextResponse.json({ error: "This item needs at least one photo for a sale event." }, { status: 400 });
  }
  const skipped = item.ebayMarkdownError?.startsWith(MARKDOWN_SKIPPED_PREFIX) ?? false;
  if (percentOff === item.markdownPercentOff && !skipped) {
    return NextResponse.json({ error: `The sale is already ${percentOff}% off.` }, { status: 400 });
  }

  // Keep the sale's own end date unless it's nearly over.
  const endDate =
    item.markdownEndsAt && item.markdownEndsAt.getTime() - Date.now() > 60 * 60 * 1000
      ? item.markdownEndsAt
      : defaultEndDate(item);

  try {
    await stopMarkdownPromotion(item.ebayMarkdownId);
  } catch (e) {
    const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Ending the current sale failed.";
    await prisma.item.update({ where: { id }, data: { ebayMarkdownError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
  // The old sale is over now; record that before starting the new one, so a
  // failure below leaves the item showing no sale rather than the old one.
  const cleared = await prisma.item.update({
    where: { id },
    data: { ebayMarkdownId: null, markdownPercentOff: null, markdownStartedAt: null, markdownEndsAt: null, ebayMarkdownError: null },
  });
  return startSale(cleared, percentOff, endDate, `Ended the ${item.markdownPercentOff}% sale, but the new one didn't start: `);
}

// Ends a sale event early — the listing itself stays live, only the
// strikethrough markdown is removed.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (!item.ebayMarkdownId) {
    return NextResponse.json({ error: "This item doesn't have an active sale event." }, { status: 400 });
  }

  try {
    await stopMarkdownPromotion(item.ebayMarkdownId);
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
