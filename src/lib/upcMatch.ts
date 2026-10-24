// Loose barcode matching for supplier spreadsheets, which mangle UPCs:
// Excel drops leading zeros, some sheets lose the check digit (and the
// importer's fix can then append a wrong one), some carry case codes, and
// a few store the real 12-digit UPC with extra digits in front (seen on
// the Medical Supplies manifest: 130382903051060 for UPC 382903051060).
// Two codes match when any of their keys match. Keys ignore leading zeros
// and the check digit, and a 14-digit case code (GTIN-14) also keys to the
// UPC it packs. Within one manifest the looseness can't realistically
// collide two different products.
const stripZeros = (s: string) => s.replace(/^0+/, "");

// A manifest line with no UPC is keyed by its Item # instead ("item:2049-02",
// see lineKey). Those only ever match exactly: Item #s like 150819 and
// 150832 sit a digit apart, which the loose barcode keys would merge.
export const ITEM_KEY_PREFIX = "item:";

// A line with neither is keyed by its own row ("line:<ManifestLine.id>"),
// found at the sort station by searching its name.
export const LINE_KEY_PREFIX = "line:";

export function isItemKey(code: string | null | undefined): boolean {
  return Boolean(code?.startsWith(ITEM_KEY_PREFIX));
}

// An Item # or row key: matched exactly, never loosely like a barcode.
export function isExactKey(code: string | null | undefined): code is string {
  return Boolean(code?.startsWith(ITEM_KEY_PREFIX) || code?.startsWith(LINE_KEY_PREFIX));
}

// The key a manifest line is counted under: its UPC, or "item:" + its
// Item # when it has no UPC (Cristian, 2026-10-24: the medical load has
// products with no barcode), or "line:" + its id when it has neither
// (pass id for that). null = nothing to key it by.
export function lineKey(line: { id?: string; upc: string | null; supplierSku?: string | null }): string | null {
  const upc = line.upc?.trim();
  if (upc) return upc;
  const sku = line.supplierSku?.trim();
  if (sku) return ITEM_KEY_PREFIX + sku;
  return line.id ? LINE_KEY_PREFIX + line.id : null;
}

// What a sorter reads for a key: "UPC 0123...", "Item # 2049-02", or that
// it has neither.
export function keyLabel(key: string): string {
  if (isItemKey(key)) return `Item # ${key.slice(ITEM_KEY_PREFIX.length)}`;
  if (key.startsWith(LINE_KEY_PREFIX)) return "No UPC or Item #";
  return `UPC ${key}`;
}

export function upcMatchKeys(code: string | null | undefined): string[] {
  if (isExactKey(code)) return [code];
  const d = (code ?? "").replace(/\D/g, "");
  if (d.length < 6) return [];
  const keys = new Set<string>([stripZeros(d), stripZeros(d.slice(0, -1))]);
  if (d.length > 12) {
    keys.add(stripZeros(d.slice(-12)));
    keys.add(stripZeros(d.slice(-12, -1)));
  }
  if (d.length === 14) keys.add(stripZeros(d.slice(1, -1)));
  keys.delete("");
  return [...keys];
}
