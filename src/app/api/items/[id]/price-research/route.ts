import { getRequestUser } from "@/lib/auth";
import { cogsMapsFor, costPerListingUnit, unitCostForScan } from "@/lib/cogs";
import { prisma } from "@/lib/prisma";
import { typicalSingleLabelCost } from "@/lib/shippingCost";
import { getTargetMarginPct } from "@/lib/sourcingAgent";
import { NextResponse } from "next/server";

export const maxDuration = 30;

// What the review page shows next to the price field: the manifest retail
// for this listing and, for the owner, what a sale costs besides eBay's
// fees (for the live profit line). Until 2026-10-18 this also searched
// active eBay listings and showed their median; eBay's API License bars
// using its data to suggest prices (sec. 9), and Cristian checks comps
// himself at review anyway, so the page now links him to eBay's own search
// instead (opened in his browser, normal use of the site).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }

  // A 3-pack item is compared against 3 units' worth of retail.
  const packSize = item.isMultipack && item.packSize ? item.packSize : 1;

  const retailLine = item.manifestId && item.upc
    ? await prisma.manifestLine.findFirst({
        where: { manifestId: item.manifestId, upc: item.upc },
        select: { retailPrice: true },
      })
    : null;
  const unitRetail = retailLine ? Number(retailLine.retailPrice) : null;
  const retailPrice = unitRetail != null ? unitRetail * packSize : null;

  // What the review page needs to show profit at whatever price gets typed
  // (fees, label and item cost are worked out there, live, with the same
  // priceOutcome the offer tools use). Owner only: employees never see
  // cost or profit.
  let profitBasis: {
    unitCost: number | null;
    typicalLabel: number;
    promotedPercent: number | null;
    targetReturnPct: number;
  } | null = null;
  if (getRequestUser(request)?.role === "owner") {
    const { cost, costed } = costPerListingUnit(item, await cogsMapsFor([item.manifestId]));
    let unitCost: number | null = costed ? cost : null;
    // Nothing received under this UPC yet: same fallback the scan page uses.
    if (unitCost == null && !item.isBundle && item.manifestId && item.upc) {
      const perUnit = await unitCostForScan(item.manifestId, item.upc);
      if (perUnit != null) unitCost = perUnit * packSize;
    }
    profitBasis = {
      unitCost,
      typicalLabel: await typicalSingleLabelCost(),
      promotedPercent: item.promotedBidPercentage,
      // Cristian's bar for listing (Settings, 35%): return on item cost.
      targetReturnPct: await getTargetMarginPct(),
    };
  }

  return NextResponse.json({ packSize, retailPrice, unitRetail, profitBasis });
}
