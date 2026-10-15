// Strict comp matching for other-supplier manifests (supplier "unknown").
// BStock / Liquidation.com keep the looser blend in sourcingAgent.ts; this
// path exists because, on the first other-supplier manifest (Medical
// Supplies, 2026-10-15), that blend priced its top lines off the wrong
// products: a UPC with no listings fell back to a keyword search on the
// description and took the median of whatever came back (a $110 BD
// catheter for a Coloplast one, a "large lot" of canisters as one
// canister's price, "CS/50" masks at $15 each).
//
// Rules: a listing counts only if it came up under the exact UPC, or its
// title carries the item's own number. Lots and cases are skipped. Prices
// are per box (the listing as sold), never divided down to pieces.

// "Lot of 10", "5 boxes", "case of", "CS/50", "bulk", "(3 box)"...
export const LOT_TITLE = /\blot\b|\bboxes\b|\bcases?\b|\bcs\/|\(\d+ box|\b\d+\s*x\s*box|\bbulk\b|\b\d+ bx\b/i;

const alnum = (s: string) => s.toLowerCase().replace(/[^0-9a-z]/g, "");

// An item number is usable to match titles when it looks like a model
// number (4+ characters with a digit) — not "N/A" or a bare word.
export function usableItemNumber(sku: string | null): string | null {
  const core = alnum(sku ?? "");
  return core.length >= 4 && /\d/.test(core) ? core : null;
}

const STOPWORDS = new Set(["the", "and", "for", "with", "pcs", "pack", "count", "box", "each", "new"]);

// Words that identify the product: 3+ letters, not a size or count.
function significantWords(description: string): string[] {
  return [
    ...new Set(
      description
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && /[a-z]/.test(w) && !/^\d/.test(w) && !STOPWORDS.has(w))
    ),
  ];
}

// What to type into eBay's search: brand + item number when there is one
// (how sellers title these), otherwise the description.
export function exactSearchKeywords(description: string, sku: string | null): string {
  const brand = description.trim().split(/\s+/)[0] ?? "";
  return usableItemNumber(sku) && sku ? `${brand} ${sku.trim()}` : description;
}

export function isExactTitleMatch(title: string, description: string, sku: string | null): boolean {
  const t = alnum(title);
  const code = usableItemNumber(sku);
  if (code) {
    if (!t.includes(code)) return false;
    // A short number like "8235" turns up in unrelated titles too, so
    // it also needs the brand.
    const brand = alnum(description.trim().split(/\s+/)[0] ?? "");
    return code.length > 5 || brand.length < 3 || t.includes(brand);
  }
  // No item number: nearly every identifying word has to be in the title.
  const words = significantWords(description);
  if (words.length < 2) return false;
  const titleLower = title.toLowerCase();
  const hits = words.filter((w) => titleLower.includes(w)).length;
  return hits / words.length >= 0.8;
}

// 3+ exact listings: their median. 1–2: the lowest, since one or two
// asking prices are a thin read (this stands in for the retail cap, which
// other-supplier manifests usually can't use — most list no retail).
export function priceFromExactComps(prices: number[]): { price: number | null; basis: "median" | "lowest" | null } {
  if (prices.length === 0) return { price: null, basis: null };
  const sorted = [...prices].sort((a, b) => a - b);
  if (sorted.length < 3) return { price: sorted[0], basis: "lowest" };
  const mid = Math.floor(sorted.length / 2);
  return { price: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, basis: "median" };
}

// Boxes as eBay sells them, from the manifest's piece count.
export function boxesFor(expectedQuantity: number, piecesPerBox: number | null): number {
  if (!piecesPerBox || piecesPerBox <= 1) return expectedQuantity;
  return expectedQuantity > 0 ? Math.max(1, Math.round(expectedQuantity / piecesPerBox)) : 0;
}
