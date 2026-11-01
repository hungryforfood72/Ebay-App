import type { ManifestSupplier } from "@/generated/prisma/client";
import { soldUnitsFor, unitsFor } from "./itemUnits";
import { prisma } from "./prisma";
import { isExactKey, lineKey, LINE_KEY_PREFIX } from "./upcMatch";
import { RETURN_NOTE_PREFIX } from "./warehouse/returnReconcile";
import { sortedByUpc } from "./warehouse/sortBoxes";
import { matchLineUpc } from "./warehouse/sortCheck";

// How a supplier's loads really arrive, for the Analyzer's receive rate and
// its notes (Cristian, 2026-11-01). Three things it learns:
// - damaged/expired on arrival, from every bought load (as before);
// - real shorts, only from loads the sort station finished (sortedAt set),
//   since until then "missing" just means not scanned yet. Only lines with
//   a UPC or Item # count: a catch-all line with neither ("Miscellaneous
//   Items", 62 x $1 on 10/14 Pallet 2) can't be matched to a scan, so it
//   would always read as short when its units are really mixed in with the
//   extras;
// - extras (units that weren't on the manifest) and units over on lines
//   that were, and what the extras earn once listed. Tracked only: not in
//   the max bid until Cristian sees it's a pattern, not a one-off (his call
//   2026-11-01, first fully sorted load).
// Consignment loads are left out of shorts and extras: they're sorted
// against a pick list, not the manifest.

export type ManifestSortCounts = {
  // Expected units on lines with a UPC or Item #.
  expected: number;
  short: number;
  over: number;
  // Not on the manifest: good (sort boxes), damaged, put in a dud box.
  extras: number;
  damagedExtras: number;
  dudExtras: number;
  // Expected units on lines with neither (never counted short).
  catchAll: number;
};

type LoadRow = {
  id: string;
  lines: { id: string; upc: string | null; supplierSku: string | null; expectedQuantity: number }[];
  damaged: { upc: string; quantity: number; note: string | null }[];
  duds: { upc: string; quantity: number }[];
};

const LOAD_SELECT = {
  id: true,
  lines: { select: { id: true, upc: true, supplierSku: true, expectedQuantity: true } },
  damaged: { select: { upc: true, quantity: true, note: true } },
  duds: { select: { upc: true, quantity: true } },
} as const;

// The line key a stored code belongs to: exact first (the sort station
// stores the line's key), then the loose barcode match. "catchAll" = a
// line with no UPC or Item # (found by name search); null = an extra.
function keyFor(keyed: string[], keyedSet: Set<string>, stored: string): string | "catchAll" | null {
  if (keyedSet.has(stored)) return stored;
  if (stored.startsWith(LINE_KEY_PREFIX)) return "catchAll";
  if (isExactKey(stored)) return null;
  return matchLineUpc(keyed, stored);
}

async function sortCountsFor(load: LoadRow): Promise<ManifestSortCounts> {
  const expectedByKey = new Map<string, number>();
  let catchAll = 0;
  for (const l of load.lines) {
    const key = l.upc?.trim() || l.supplierSku?.trim() ? lineKey(l) : null;
    if (!key) catchAll += l.expectedQuantity;
    else expectedByKey.set(key, (expectedByKey.get(key) ?? 0) + l.expectedQuantity);
  }
  const keyed = [...expectedByKey.keys()];
  const keyedSet = new Set(keyed);
  const countedByKey = new Map<string, number>();
  const tally = (stored: string, units: number): boolean => {
    const key = keyFor(keyed, keyedSet, stored);
    if (key === "catchAll") return true;
    if (!key) return false;
    countedByKey.set(key, (countedByKey.get(key) ?? 0) + units);
    return true;
  };

  let extras = 0;
  for (const [stored, s] of await sortedByUpc(load.id)) if (!tally(stored, s.sorted)) extras += s.sorted;
  let damagedExtras = 0;
  for (const d of load.damaged) {
    // A customer return written off came out of an earlier listing, not
    // off the truck.
    if (d.note?.startsWith(RETURN_NOTE_PREFIX)) continue;
    if (!tally(d.upc, d.quantity)) damagedExtras += d.quantity;
  }
  let dudExtras = 0;
  for (const d of load.duds) if (!tally(d.upc, d.quantity)) dudExtras += d.quantity;

  let short = 0;
  let over = 0;
  let expected = 0;
  for (const [key, e] of expectedByKey) {
    const c = countedByKey.get(key) ?? 0;
    expected += e;
    if (c < e) short += e - c;
    else over += c - e;
  }
  return { expected, short, over, extras, damagedExtras, dudExtras, catchAll };
}

export async function manifestSortCounts(manifestId: string): Promise<ManifestSortCounts> {
  return sortCountsFor(await prisma.manifest.findUniqueOrThrow({ where: { id: manifestId }, select: LOAD_SELECT }));
}

export type SupplierStats = {
  // Every bought load: damaged/expired on arrival (extras left out, they
  // were never on the manifest) over all expected units.
  loads: number;
  expectedUnits: number;
  damagedUnits: number;
  damageRate: number;
  // Loads the sort station finished (not consignment).
  sortedLoads: number;
  sortedExpectedUnits: number;
  shortUnits: number;
  shortRate: number;
  overUnits: number;
  extraUnits: number;
  catchAllUnits: number;
  // Extras from those loads once listed: units listed and sold, and what
  // they really earned (revenue less fees, label and net refunds; no cost,
  // they came free on top of the load).
  extraUnitsListed: number;
  extraUnitsSold: number;
  extraNet: number;
  // 1 - damageRate - shortRate, clamped like the old damage-only rate.
  receiveRate: number;
};

export async function supplierStats(supplier: ManifestSupplier): Promise<SupplierStats> {
  // Analyzer candidates never bought (purchased false) and Beta copies
  // (repeats of another load) have no real arrivals to learn from.
  const loads = await prisma.manifest.findMany({
    where: { supplier, purchased: true, analyzerBeta: false },
    select: { ...LOAD_SELECT, sortedAt: true, consignment: true },
  });

  const s: SupplierStats = {
    loads: loads.length,
    expectedUnits: 0,
    damagedUnits: 0,
    damageRate: 0,
    sortedLoads: 0,
    sortedExpectedUnits: 0,
    shortUnits: 0,
    shortRate: 0,
    overUnits: 0,
    extraUnits: 0,
    catchAllUnits: 0,
    extraUnitsListed: 0,
    extraUnitsSold: 0,
    extraNet: 0,
    receiveRate: 1,
  };

  for (const load of loads) {
    const counts = await sortCountsFor(load);
    const damaged = load.damaged
      .filter((d) => !d.note?.startsWith(RETURN_NOTE_PREFIX))
      .reduce((sum, d) => sum + d.quantity, 0);
    s.expectedUnits += load.lines.reduce((sum, l) => sum + l.expectedQuantity, 0);
    s.damagedUnits += damaged - counts.damagedExtras;
    if (!load.sortedAt || load.consignment) continue;

    s.sortedLoads++;
    s.sortedExpectedUnits += counts.expected;
    s.shortUnits += counts.short;
    s.overUnits += counts.over;
    s.extraUnits += counts.extras;
    s.catchAllUnits += counts.catchAll;

    // Listings of products that weren't on the manifest.
    const keyed = load.lines.map((l) => (l.upc?.trim() || l.supplierSku?.trim() ? lineKey(l) : null)).filter((k): k is string => k != null);
    const items = await prisma.item.findMany({
      where: { manifestId: load.id, isBundle: false, upc: { not: null } },
      select: {
        upc: true,
        quantity: true,
        isMultipack: true,
        packSize: true,
        soldQuantity: true,
        soldRevenueTotal: true,
        soldFeesTotal: true,
        soldShippingTotal: true,
        sales: { select: { refunds: { select: { amount: true, feeCredit: true } } } },
      },
    });
    for (const item of items) {
      if (keyed.includes(item.upc!) || matchLineUpc(keyed, item.upc!)) continue;
      const refunds = item.sales.flatMap((x) => x.refunds).reduce((sum, r) => sum + Number(r.amount) - Number(r.feeCredit), 0);
      s.extraUnitsListed += unitsFor(item);
      s.extraUnitsSold += soldUnitsFor(item);
      s.extraNet += Number(item.soldRevenueTotal) - Number(item.soldFeesTotal) - Number(item.soldShippingTotal) - refunds;
    }
  }

  s.damageRate = s.expectedUnits > 0 ? Math.max(0, s.damagedUnits) / s.expectedUnits : 0;
  s.shortRate = s.sortedExpectedUnits > 0 ? s.shortUnits / s.sortedExpectedUnits : 0;
  // No history yet: no haircut (lean on the market signal early).
  s.receiveRate = s.expectedUnits === 0 ? 1 : Math.max(0.5, Math.min(1, 1 - s.damageRate - s.shortRate));
  return s;
}

// One paragraph for the Analyzer's reasoning and its supplier note.
export function describeSupplierStats(supplier: ManifestSupplier, s: SupplierStats): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const parts = [
    `Supplier ${supplier}: receive rate ${pct(s.receiveRate)} across ${s.loads} bought load(s): ${pct(s.damageRate)} damaged/expired on arrival`,
  ];
  if (s.sortedLoads === 0) {
    parts.push("; shorts not measured yet (no load fully sorted at the sort station).");
    return parts.join("");
  }
  parts.push(
    `, ${pct(s.shortRate)} really short (${s.shortUnits} of ${s.sortedExpectedUnits} units on ${s.sortedLoads} fully sorted load(s); catch-all lines with no UPC or Item #, ${s.catchAllUnits} units, never count as short).`
  );
  const per100 = (n: number) => ((n / s.sortedExpectedUnits) * 100).toFixed(1);
  parts.push(
    ` Extras on those loads: ${per100(s.extraUnits)} units not on the manifest and ${per100(s.overUnits)} over on listed lines per 100 expected (${s.extraUnits} + ${s.overUnits} units).`
  );
  parts.push(
    s.extraUnitsListed > 0
      ? ` Of the extras, ${s.extraUnitsListed} listed and ${s.extraUnitsSold} sold so far, netting $${s.extraNet.toFixed(2)} ($${(s.extraNet / Math.max(1, s.extraUnits)).toFixed(2)} per extra received).`
      : " None of the extras has been listed yet, so there's no sales data on them."
  );
  parts.push(" Extras are tracked only and are NOT part of the max bid until they prove to be a regular pattern.");
  return parts.join("");
}
