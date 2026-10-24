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

export function isItemKey(code: string | null | undefined): code is string {
  return Boolean(code?.startsWith(ITEM_KEY_PREFIX));
}

// The key a manifest line is counted under: its UPC, or "item:" + its
// Item # when it has no UPC (Cristian, 2026-10-24: the medical load has
// products with no barcode). null = neither, nothing to scan it by.
export function lineKey(line: { upc: string | null; supplierSku?: string | null }): string | null {
  const upc = line.upc?.trim();
  if (upc) return upc;
  const sku = line.supplierSku?.trim();
  return sku ? ITEM_KEY_PREFIX + sku : null;
}

// What a sorter reads for a key: "UPC 0123..." or "Item # 2049-02".
export function keyLabel(key: string): string {
  return isItemKey(key) ? `Item # ${key.slice(ITEM_KEY_PREFIX.length)}` : `UPC ${key}`;
}

export function upcMatchKeys(code: string | null | undefined): string[] {
  if (isItemKey(code)) return [code];
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
