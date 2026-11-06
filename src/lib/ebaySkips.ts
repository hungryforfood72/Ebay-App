import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";

// eBay skips (Cristian, 2026-11-03): products the listing station kept off
// eBay because the pack card said eBay isn't worth it, either set aside
// into a dud box (ManifestDudEntry.setAsideReason) or listed Shopify &
// Whatnot only (Item.ebaySkipReason).
//
// eBay is the focus. What these bring in on Shopify or Whatnot is extra
// money, tracked but never fed into bids. What the Analyzer learns from
// them is the eBay side only: a product we passed on for eBay (enough
// times to trust, see passedOnEbayBefore), and that has never sold on eBay
// for us, is a dud the next time it's on a manifest.
// If it later sells on eBay (listed from a dud box, say), our own eBay
// sales take over as they do for any product.

// The pack card's setAside.why values (packSuggestion.ts).
export const EBAY_SKIP_REASONS = ["slow_single", "low_return", "no_demand", "price_unclear"] as const;
export type EbaySkipReason = (typeof EBAY_SKIP_REASONS)[number];

export function isEbaySkipReason(v: unknown): v is EbaySkipReason {
  return typeof v === "string" && (EBAY_SKIP_REASONS as readonly string[]).includes(v);
}

// Reasons that mean "not worth it on eBay". price_unclear only means the
// price research disagreed, so it teaches the Analyzer nothing.
export const NOT_WORTH_ON_EBAY: readonly EbaySkipReason[] = ["slow_single", "low_return", "no_demand"];

export const EBAY_SKIP_TEXT: Record<EbaySkipReason, string> = {
  slow_single: "Set aside at listing: one on its own sells too slowly on eBay",
  low_return: "Set aside at listing: shipping and fees eat the eBay sale",
  no_demand: "Set aside at listing: no eBay demand found",
  price_unclear: "Set aside at listing: price research didn't agree",
};

// Dud entries the sort station logged (the units never went in a sort
// box), vs set-asides from the listing station (they did: counted as good
// at sorting already). Sort-count tallies use SORT_DUD_ENTRY so set-aside
// units aren't counted twice.
export const SORT_DUD_ENTRY = { setAsideReason: null } satisfies Prisma.ManifestDudEntryWhereInput;
export const SET_ASIDE_ENTRY = { setAsideReason: { not: null } } satisfies Prisma.ManifestDudEntryWhereInput;

// Physical units kept off eBay per stored UPC, across every load: set-aside
// units still in a dud box or since listed from one on Shopify, plus
// Shopify only listings the pack card sent there. notWorthOnly:
// just the reasons that teach the Analyzer (NOT_WORTH_ON_EBAY).
export async function ebaySkippedUnits(args: {
  manifestId?: string;
  upcs?: string[];
  notWorthOnly?: boolean;
}): Promise<Map<string, number>> {
  const reasons = args.notWorthOnly ? [...NOT_WORTH_ON_EBAY] : [...EBAY_SKIP_REASONS];
  const scope = {
    ...(args.manifestId ? { manifestId: args.manifestId } : {}),
    ...(args.upcs ? { upc: { in: args.upcs } } : {}),
  };
  const [entries, items] = await Promise.all([
    prisma.manifestDudEntry.findMany({
      where: { ...scope, setAsideReason: { in: reasons } },
      select: { upc: true, quantity: true, decision: true },
    }),
    prisma.item.findMany({
      // Still off eBay: unticked at review means it went on eBay after all.
      where: { ...scope, ebaySkipReason: { in: reasons }, shopifyOnly: true, isBundle: false },
      select: { upc: true, quantity: true, isMultipack: true, packSize: true },
    }),
  ]);
  const out = new Map<string, number>();
  const add = (upc: string | null, units: number) => {
    if (!upc || units <= 0) return;
    out.set(upc, (out.get(upc) ?? 0) + units);
  };
  // A set-aside decided "ebay" is going on eBay after all: not a skip.
  for (const e of entries) if (e.decision !== "ebay") add(e.upc, e.quantity);
  for (const i of items) add(i.upc, i.quantity * (i.isMultipack && i.packSize ? i.packSize : 1));
  return out;
}

// The extra money a load's duds and set-asides brought in (owner only, on
// the load's page): everything listed from its dud boxes, plus listings the
// pack card sent to Shopify. No item cost: the load's cost is
// already carried by the good stock, so what these net is all extra.
// Before refunds. Whatnot sales show up once Whatnot's orders reach
// Shopify (ShopifySale.channel "whatnot").
export type ExtraChannel = { units: number; revenue: number; net: number };
export type DudExtra = { ebay: ExtraChannel; shopify: ExtraChannel; whatnot: ExtraChannel; listings: number };

export async function dudExtraForManifest(manifestId: string): Promise<DudExtra> {
  const items = await prisma.item.findMany({
    // A pack-card skip unticked at review went on eBay after all: not extra.
    where: { manifestId, OR: [{ fromDudBoxId: { not: null } }, { ebaySkipReason: { not: null }, shopifyOnly: true }] },
    select: { id: true, isMultipack: true, packSize: true },
  });
  const empty = (): ExtraChannel => ({ units: 0, revenue: 0, net: 0 });
  const out: DudExtra = { ebay: empty(), shopify: empty(), whatnot: empty(), listings: items.length };
  if (items.length === 0) return out;
  const byId = new Map(items.map((i) => [i.id, i]));
  const units = (itemId: string, quantity: number) => {
    const i = byId.get(itemId);
    return quantity * (i?.isMultipack && i.packSize ? i.packSize : 1);
  };
  const ids = items.map((i) => i.id);
  const [ebay, shop] = await Promise.all([
    prisma.ebayItemSale.findMany({
      where: { itemId: { in: ids } },
      select: { itemId: true, quantity: true, revenue: true, fees: true, shipping: true },
    }),
    prisma.shopifySale.findMany({
      where: { itemId: { in: ids } },
      select: { itemId: true, quantity: true, revenue: true, fees: true, channel: true },
    }),
  ]);
  for (const s of ebay) {
    out.ebay.units += units(s.itemId, s.quantity);
    out.ebay.revenue += Number(s.revenue);
    out.ebay.net += Number(s.revenue) - Number(s.fees) - Number(s.shipping);
  }
  for (const s of shop) {
    const c = s.channel === "whatnot" ? out.whatnot : out.shopify;
    c.units += units(s.itemId, s.quantity);
    c.revenue += Number(s.revenue);
    c.net += Number(s.revenue) - Number(s.fees);
  }
  const round = (c: ExtraChannel) => {
    c.revenue = Math.round(c.revenue * 100) / 100;
    c.net = Math.round(c.net * 100) / 100;
  };
  round(out.ebay);
  round(out.shopify);
  round(out.whatnot);
  return out;
}

// For the Analyzer: did we pass on eBay for this UPC before (not-worth
// reasons only), with enough behind it to trust? One set-aside of a single
// unit says little (a lone bottle doesn't pay; ten might bundle), and one
// mis-tap shouldn't zero a product in every future bid. So it takes at
// least SKIP_MIN_UNITS units, or passes on SKIP_MIN_LOADS different loads,
// within the last SKIP_WINDOW_DAYS. Exact UPC, the same way the Analyzer's
// own eBay sales are matched, so a sale under this UPC always clears it.
// Loaded once and kept for a few minutes, since an evaluation asks for
// every line on the manifest.
const SKIP_MIN_UNITS = 3;
const SKIP_MIN_LOADS = 2;
const SKIP_WINDOW_DAYS = 180;
const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; upcs: Set<string> } | null = null;

async function trustedSkips(): Promise<Set<string>> {
  const since = new Date(Date.now() - SKIP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const reasons = [...NOT_WORTH_ON_EBAY];
  const [entries, items] = await Promise.all([
    prisma.manifestDudEntry.findMany({
      where: { setAsideReason: { in: reasons }, createdAt: { gte: since }, NOT: { decision: "ebay" } },
      select: { upc: true, quantity: true, manifestId: true },
    }),
    prisma.item.findMany({
      where: { ebaySkipReason: { in: reasons }, shopifyOnly: true, isBundle: false, createdAt: { gte: since } },
      select: { upc: true, quantity: true, isMultipack: true, packSize: true, manifestId: true },
    }),
  ]);
  const byUpc = new Map<string, { units: number; loads: Set<string> }>();
  const add = (upc: string | null, units: number, manifestId: string | null) => {
    if (!upc) return;
    const row = byUpc.get(upc) ?? { units: 0, loads: new Set<string>() };
    row.units += units;
    if (manifestId) row.loads.add(manifestId);
    byUpc.set(upc, row);
  };
  for (const e of entries) add(e.upc, e.quantity, e.manifestId);
  for (const i of items) add(i.upc, i.quantity * (i.isMultipack && i.packSize ? i.packSize : 1), i.manifestId);
  return new Set(
    [...byUpc.entries()].filter(([, r]) => r.units >= SKIP_MIN_UNITS || r.loads.size >= SKIP_MIN_LOADS).map(([u]) => u)
  );
}

export async function passedOnEbayBefore(upc: string | null): Promise<boolean> {
  if (!upc) return false;
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), upcs: await trustedSkips() };
  return cache.upcs.has(upc);
}
