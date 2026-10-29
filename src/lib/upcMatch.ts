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

// The barcode as eBay's UPC/EAN field takes it, or null to leave the field
// blank. eBay rejects the whole listing over a bad one (2026-10-29: a BD
// syringe bag from the medical load carried "0130382903052180", a GS1
// DataMatrix read: "01" + the case-level GTIN-14 30382903052180). Takes:
// - a GS1 read ("01" + GTIN-14, maybe with expiry/lot after it),
// - a GTIN-14 whose indicator digit is 0 (the retail code with padding),
// - 12-digit UPCs, 11-digit ones Excel dropped the leading zero from, and
//   13-digit EANs (a leading-0 EAN is a UPC).
// Case codes (indicator 1-8) and anything with a wrong check digit have no
// UPC to give: guessing one would put a different product's code on it.
export function ebayProductCode(code: string | null | undefined): { upc: string } | { ean: string } | null {
  // Digits only, so Item # and row keys ("item:...") fall out here too.
  let d = code?.trim() ?? "";
  if (!/^[\d\s-]+$/.test(d)) return null;
  d = d.replace(/\D/g, "");
  if (d.length >= 16 && d.startsWith("01") && validCheckDigit(d.slice(2, 16))) d = d.slice(2, 16);
  if (d.length === 14) {
    if (!d.startsWith("0")) return null;
    d = d.slice(1);
  }
  if (d.length === 13 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 11) d = "0" + d;
  if (!validCheckDigit(d)) return null;
  if (d.length === 12) return { upc: d };
  if (d.length === 13) return { ean: d };
  return null;
}

// GS1 mod-10 check digit (UPC-A, EAN-13, GTIN-14 all use it).
function validCheckDigit(d: string): boolean {
  if (!/^\d{8,14}$/.test(d)) return false;
  let sum = 0;
  for (let i = d.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(d[i]) * w;
  return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
}
