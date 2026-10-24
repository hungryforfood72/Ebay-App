import type { Prisma } from "@/generated/prisma/client";
import { ebayBanReason } from "../ebayBanned";
import { parseBundleComponentUnits, unitsFor } from "../itemUnits";
import { prisma } from "../prisma";
import { ITEM_KEY_PREFIX, isItemKey, lineKey, upcMatchKeys } from "../upcMatch";
import { returnedUnitsByUpc } from "./returnReconcile";
import { sortedByUpc } from "./sortBoxes";

// The sort station's "is this a dud?" call, and the per-product counts it
// shows. The call itself was already made before the load was bought: the
// Analyzer's SourcingLineEstimate.flaggedDud for that UPC (plus eBay's
// banned list, which needs no evaluation at all). This just turns it into
// a short reason a sorter can read in a second. Server only.

// The estimate fields the reason (and the owner's money hint on the dud box
// page) are built from. Kept small so the sort check stays one quick query.
export const DUD_ESTIMATE_SELECT = {
  upc: true,
  description: true,
  flaggedDud: true,
  slowMover: true,
  monthsToSellThrough: true,
  postHolidayFiller: true,
  eventEnded: true,
  estimatedUnitSalePrice: true,
  estimatedUnitFees: true,
  estimatedUnitShipping: true,
} as const satisfies Prisma.SourcingLineEstimateSelect;

export type DudEstimate = Prisma.SourcingLineEstimateGetPayload<{ select: typeof DUD_ESTIMATE_SELECT }>;

export type DudCall = {
  dud: boolean;
  // Short and plain, for the sorter (and whoever processes the dud box).
  // Also set when it's NOT a dud but there's something worth saying, like
  // the load never having been through the Analyzer.
  reason: string | null;
};

// Re-running the Analyzer keeps old runs as history, and a run can still
// be going or have failed, so "the call" is the newest finished one.
export async function latestCompleteEvaluationId(manifestId: string): Promise<string | null> {
  const ev = await prisma.sourcingEvaluation.findFirst({
    where: { manifestId, status: "complete" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  return ev?.id ?? null;
}

// "eBay bans needles" -> "eBay doesn't allow needles".
function bannedText(reason: string): string {
  return reason.replace(/^eBay bans /, "eBay doesn't allow ");
}

const ANALYZER = "The Analyzer marked this as a dud";

// Why the Analyzer called it a dud, most specific first. Mirrors the order
// flaggedDud gets set in sourcingAgent.ts: banned, then the calendar rules
// (they override any price), then sell speed, then the price math itself.
//
// One exception: a flag only the retired crowded-market rule explains is
// NOT a dud here. That rule (lots of listings + no track record = dud) was
// dropped on 2026-10-16 because it dudded good sellers, but runs from
// before then still carry its flag (often without crowdedMarket set, the
// column came later): a positive price with nothing else wrong. The 10/14
// pallets' 10/12 run had 357 of 855 products flagged that way, Hask
// shampoo at ~$7 net among them; following it would send most of the load
// to dud boxes and off eBay. Re-running the Analyzer replaces the call.
export function dudCall(args: { description: string; evaluated: boolean; estimate: DudEstimate | null }): DudCall {
  // eBay's banned list is checked straight from the description, so it
  // works for loads the Analyzer never saw (and runs from before it
  // existed).
  const banned = ebayBanReason(args.description) ?? (args.estimate ? ebayBanReason(args.estimate.description) : null);
  if (banned) return { dud: true, reason: bannedText(banned) };
  if (!args.evaluated) return { dud: false, reason: "No Analyzer call for this load" };
  const e = args.estimate;
  if (!e) return { dud: false, reason: "The Analyzer didn't check this product" };
  if (!e.flaggedDud) return { dud: false, reason: null };
  if (e.postHolidayFiller) return { dud: true, reason: "Holiday item, season's over" };
  if (e.eventEnded) return { dud: true, reason: "The event it's for is over" };
  if (e.slowMover) return { dud: true, reason: `${ANALYZER}: sells too slowly` };
  const price = e.estimatedUnitSalePrice != null ? Number(e.estimatedUnitSalePrice) : 0;
  if (price <= 0) return { dud: true, reason: `${ANALYZER}: no sales found for it` };
  const net = price - Number(e.estimatedUnitFees ?? 0) - Number(e.estimatedUnitShipping ?? 0);
  if (net <= 0) return { dud: true, reason: `${ANALYZER}: doesn't sell for enough to cover fees and shipping` };
  return { dud: false, reason: "Old Analyzer rule flagged this, but it's not a dud anymore" };
}

// The manifest line UPC a scan belongs to. Spreadsheets mangle barcodes
// (see upcMatchKeys), so the line sharing the most match keys with the
// scan wins, same as the sort page always did.
export function matchLineUpc(lineUpcs: (string | null)[], scanned: string): string | null {
  if (isItemKey(scanned)) return lineUpcs.includes(scanned) ? scanned : null;
  const keys = new Set(upcMatchKeys(scanned));
  if (keys.size === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const upc of new Set(lineUpcs)) {
    if (!upc) continue;
    const score = upcMatchKeys(upc).filter((k) => keys.has(k)).length;
    if (score > bestScore) {
      best = upc;
      bestScore = score;
    }
  }
  return best;
}

// The line key (lineKey) a scan or typed code belongs to: the UPC match
// first, then the code as an Item # (exact, ignoring case and spaces), so a
// product with no barcode can be typed in by its Item #. Several lines can
// share an Item #; one keyed by it (no UPC) wins, since that's why it's
// being typed.
export function matchLineCode(
  lines: { upc: string | null; supplierSku: string | null }[],
  scanned: string
): string | null {
  const byUpc = matchLineUpc(
    lines.map((l) => lineKey(l)),
    scanned
  );
  if (byUpc) return byUpc;
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const wanted = norm(isItemKey(scanned) ? scanned.slice(ITEM_KEY_PREFIX.length) : scanned);
  if (!wanted) return null;
  const keys = lines
    .filter((l) => l.supplierSku && norm(l.supplierSku) === wanted)
    .map((l) => lineKey(l))
    .filter((k): k is string => k != null);
  return keys.find((k) => isItemKey(k)) ?? keys[0] ?? null;
}

export type ProductCounts = {
  received: number;
  damaged: number;
  dud: number;
  // The sort station's own physical count: good units boxed (sort boxes)
  // and every dud unit put in a dud box, listed since or not.
  sorted: number;
  dudLogged: number;
};

// Units in sortedByUpc that are this product, matched loosely (an extra's
// stored code is whatever was scanned). onlyExtra: just the "not on the
// manifest" ones.
export function sortedUnitsFor(
  sorted: Map<string, { sorted: number; extra: boolean }>,
  upc: string,
  onlyExtra = false
): number {
  const keys = new Set(upcMatchKeys(upc));
  let total = 0;
  for (const [stored, s] of sorted) {
    if (onlyExtra && !s.extra) continue;
    if (stored === upc || upcMatchKeys(stored).some((k) => keys.has(k))) total += s.sorted;
  }
  return total;
}

// One product's counts on a manifest, the same buckets the manifest page
// reconciles with (GET /api/manifests/[id]): received = listed units, on
// their own or inside bundles, plus walk-up sales, less customer returns
// put back on the shelf (returnReconcile.ts); dud = dud entries less
// the units since listed from a dud box (those are Items now, already in
// received). Exact UPC, like the manifest page.
export async function productCounts(manifestId: string, upc: string): Promise<ProductCounts> {
  const [items, bundles, walkups, damaged, duds, returned, sorted] = await Promise.all([
    prisma.item.findMany({
      where: { manifestId, upc, isBundle: false },
      select: { quantity: true, isMultipack: true, packSize: true },
    }),
    prisma.item.findMany({ where: { manifestId, isBundle: true }, select: { quantity: true, bundleComponents: true } }),
    prisma.manifestWalkupSale.aggregate({ where: { manifestId, upc }, _sum: { quantity: true } }),
    prisma.manifestDamagedEntry.aggregate({ where: { manifestId, upc }, _sum: { quantity: true } }),
    prisma.manifestDudEntry.aggregate({ where: { manifestId, upc }, _sum: { quantity: true, listedUnits: true } }),
    returnedUnitsByUpc(manifestId),
    sortedByUpc(manifestId),
  ]);
  const inBundles = bundles.reduce(
    (sum, b) =>
      sum +
      parseBundleComponentUnits(b.bundleComponents)
        .filter((c) => c.upc === upc)
        .reduce((s, c) => s + c.unitsPerBundle * b.quantity, 0),
    0
  );
  return {
    // Customer returns back on the shelf aren't new arrivals (see
    // returnReconcile.ts).
    received: Math.max(
      0,
      items.reduce((sum, i) => sum + unitsFor(i), 0) +
        inBundles +
        (walkups._sum.quantity ?? 0) -
        (returned.get(upc) ?? 0)
    ),
    damaged: damaged._sum.quantity ?? 0,
    dud: (duds._sum.quantity ?? 0) - (duds._sum.listedUnits ?? 0),
    sorted: sortedUnitsFor(sorted, upc),
    dudLogged: duds._sum.quantity ?? 0,
  };
}
