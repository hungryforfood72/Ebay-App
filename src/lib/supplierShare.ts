import { getConsignmentLedger } from "./consignmentLedger";
import { soldUnitsFor, unitsFor } from "./itemUnits";
import { prisma } from "./prisma";
import { upcMatchKeys } from "./upcMatch";

// ---------------------------------------------------------------------------
// The consignment supplier's read-only report (/s/{token}), Cristian
// 2026-10-17. Anyone with the link can see it, without logging in, and it's
// the only thing the link opens. Live numbers, only for what was taken:
// products picked as TAKE at his place or scanned into this manifest. No
// Analyzer estimates and nothing about what was left behind.
//
// Once the delivered load has been through the sort station (2026-10-21),
// that count is what was taken: the pick scans at his place are ignored
// (the delivery may not match them) and units set aside to go back to him
// never show.
// ---------------------------------------------------------------------------

export type SupplierProductStatus = "picked_up" | "being_listed" | "listed" | "sold_out" | "removed";

export type SupplierReport = {
  title: string;
  supplierPct: number;
  products: {
    key: string;
    description: string;
    itemNumbers: string[];
    takenUnits: number | null;
    listedUnits: number;
    soldUnits: number;
    status: SupplierProductStatus;
    ebayUrl: string | null;
    profit: number;
    hisShare: number;
  }[];
  totals: {
    takenUnits: number;
    listedUnits: number;
    soldUnits: number;
    sales: number;
    costs: number;
    profit: number;
    hisShare: number;
    paid: number;
    owed: number;
  };
  sales: { id: string; soldAt: Date; product: string; channel: string; units: number; revenue: number; costs: number; profit: number; hisShare: number }[];
  payments: { id: string; amount: number; paidAt: Date; note: string | null }[];
  updatedAt: Date;
};

// 24 random bytes = 32 URL-safe characters (192 bits): not guessable, and
// SHARE_TOKEN_PATTERN in proxy.ts only lets exactly this shape through.
export function newShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export async function getSupplierReport(token: string): Promise<SupplierReport | null> {
  if (!token || token.length < 20) return null;
  const manifest = await prisma.manifest.findFirst({
    where: { shareToken: token, consignment: true },
    select: {
      id: true,
      title: true,
      lines: { select: { upc: true, supplierSku: true, description: true } },
      items: {
        where: { isBundle: false },
        select: {
          upc: true,
          finalTitle: true,
          aiTitle: true,
          status: true,
          quantity: true,
          soldQuantity: true,
          isMultipack: true,
          packSize: true,
          ebayListingId: true,
          shopifyOnly: true,
        },
      },
      walkupSales: { select: { upc: true, quantity: true } },
      pickScans: { where: { decision: "take" }, select: { code: true } },
      sortBoxEntries: { select: { upc: true, quantity: true } },
    },
  });
  if (!manifest) return null;
  const ledger = await getConsignmentLedger(manifest.id);
  if (!ledger) return null;

  // One product per manifest line UPC (lines repeat a UPC across boxes).
  // Scanned items and walk-ups match a line loosely (see upcMatchKeys);
  // anything that doesn't is its own product.
  type Product = SupplierReport["products"][number] & { keys: string[]; picked: boolean; statuses: string[] };
  const products = new Map<string, Product>();
  const blank = (key: string, description: string, itemNumbers: string[], keys: string[]): Product => ({
    key,
    description,
    itemNumbers,
    takenUnits: null,
    listedUnits: 0,
    soldUnits: 0,
    status: "picked_up",
    ebayUrl: null,
    profit: 0,
    hisShare: 0,
    keys,
    picked: false,
    statuses: [],
  });
  for (const line of manifest.lines) {
    if (!line.upc) continue;
    const existing = products.get(line.upc);
    if (existing) {
      if (line.supplierSku && !existing.itemNumbers.includes(line.supplierSku)) existing.itemNumbers.push(line.supplierSku);
      continue;
    }
    products.set(line.upc, blank(line.upc, line.description, line.supplierSku ? [line.supplierSku] : [], upcMatchKeys(line.upc)));
  }
  const productFor = (upc: string | null, fallbackTitle: string): Product => {
    const keys = new Set(upcMatchKeys(upc));
    let best: Product | null = null;
    let bestScore = 0;
    for (const p of products.values()) {
      const score = p.keys.filter((k) => keys.has(k)).length;
      if (score > bestScore) [best, bestScore] = [p, score];
    }
    if (best) return best;
    const key = `item:${upc ?? fallbackTitle}`;
    if (!products.has(key)) products.set(key, blank(key, fallbackTitle, [], [...keys]));
    return products.get(key)!;
  };

  const sortedIn = new Map<Product, number>();
  if (manifest.sortBoxEntries.length > 0) {
    for (const e of manifest.sortBoxEntries) {
      const p = productFor(e.upc, `UPC ${e.upc}`);
      p.picked = true;
      sortedIn.set(p, (sortedIn.get(p) ?? 0) + e.quantity);
    }
  } else {
    for (const scan of manifest.pickScans) productFor(scan.code, scan.code).picked = true;
  }
  for (const item of manifest.items) {
    const p = productFor(item.upc, item.finalTitle ?? item.aiTitle ?? "Item");
    p.picked = true;
    const units = unitsFor(item);
    const sold = soldUnitsFor(item);
    p.takenUnits = (p.takenUnits ?? 0) + units;
    p.soldUnits += sold;
    const live = item.status === "listed" || item.status === "exported";
    if (live) p.listedUnits += Math.max(0, units - sold);
    if (live && item.ebayListingId && !item.shopifyOnly && !p.ebayUrl) p.ebayUrl = `https://www.ebay.com/itm/${item.ebayListingId}`;
    p.statuses.push(item.status);
  }
  for (const w of manifest.walkupSales) {
    const p = productFor(w.upc, `UPC ${w.upc}`);
    p.picked = true;
    p.takenUnits = (p.takenUnits ?? 0) + w.quantity;
    p.soldUnits += w.quantity;
    p.statuses.push("sold");
  }
  // Counted in at sorting: at least that many were taken, listed or not.
  for (const [p, units] of sortedIn) p.takenUnits = Math.max(p.takenUnits ?? 0, units);
  for (const sale of ledger.sales) {
    const p = productFor(sale.upc, sale.title);
    p.profit += sale.profit;
    p.hisShare += sale.supplierShare;
  }

  const shown = [...products.values()]
    .filter((p) => p.picked)
    .map((full) => {
      const { statuses } = full;
      const p = {
        key: full.key,
        description: full.description,
        itemNumbers: full.itemNumbers,
        takenUnits: full.takenUnits,
        listedUnits: full.listedUnits,
        soldUnits: full.soldUnits,
        ebayUrl: full.ebayUrl,
        profit: full.profit,
        hisShare: full.hisShare,
      };
      let status: SupplierProductStatus = "picked_up";
      if (p.listedUnits > 0) status = "listed";
      else if (statuses.length > 0 && statuses.every((s) => s === "sold")) status = "sold_out";
      else if (statuses.some((s) => s === "pending_review" || s === "ready")) status = "being_listed";
      else if (statuses.length > 0 && p.soldUnits > 0 && statuses.every((s) => s === "sold" || s === "expired")) status = "sold_out";
      else if (statuses.some((s) => s === "expired")) status = "removed";
      return { ...p, status, profit: Math.round(p.profit * 100) / 100, hisShare: Math.round(p.hisShare * 100) / 100 };
    })
    .sort((a, b) => b.soldUnits - a.soldUnits || a.description.localeCompare(b.description));

  const productName = (upc: string | null, title: string) => productFor(upc, title).description;
  return {
    title: manifest.title,
    supplierPct: ledger.supplierPct,
    products: shown,
    totals: {
      takenUnits: shown.reduce((s, p) => s + (p.takenUnits ?? 0), 0),
      listedUnits: shown.reduce((s, p) => s + p.listedUnits, 0),
      soldUnits: shown.reduce((s, p) => s + p.soldUnits, 0),
      sales: Math.round(ledger.sales.reduce((s, x) => s + x.revenue, 0) * 100) / 100,
      costs: Math.round(ledger.sales.reduce((s, x) => s + x.costs, 0) * 100) / 100,
      profit: Math.round(ledger.sales.reduce((s, x) => s + x.profit, 0) * 100) / 100,
      hisShare: ledger.earned,
      paid: ledger.paid,
      owed: ledger.balance,
    },
    sales: ledger.sales.map((s) => ({
      id: s.id,
      soldAt: s.soldAt,
      product: productName(s.upc, s.title),
      channel: s.channel,
      units: s.units,
      revenue: s.revenue,
      costs: s.costs,
      profit: s.profit,
      hisShare: s.supplierShare,
    })),
    payments: ledger.payments.map((p) => ({ id: p.id, amount: p.amount, paidAt: p.paidAt, note: p.note })),
    updatedAt: new Date(),
  };
}
