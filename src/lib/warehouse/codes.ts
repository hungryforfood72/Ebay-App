// Barcode formats for warehouse mode. Each kind has its own prefix so any
// scan field can tell what was scanned without asking:
//   ES000123  item label (= the item's sku and eBay custom label)
//   BN0001    bin
//   BX001     box size
// Shelves keep whatever labels they already have in ShelfLocation ("A5").
// UPCs are all digits, so they never collide with these.
//
// Item codes are letters + digits only on purpose: eBay's Inventory API
// rejects most punctuation in a SKU, and toEbaySku() strips it, so a code
// with a dash would print one way on the label and read another way on
// eBay. Safe to import from client components.

export const ITEM_CODE_PREFIX = "ES";
export const BIN_CODE_PREFIX = "BN";
export const BOX_CODE_PREFIX = "BX";

const ITEM_RE = /^ES\d{6,}$/;
const BIN_RE = /^BN\d{4,}$/;
const BOX_RE = /^BX\d{3,}$/;
const UPC_RE = /^\d{8,14}$/;

export type ScanKind = "item" | "bin" | "box" | "upc" | "other";

// Scanners sometimes add whitespace or send lowercase; normalize first.
export function normalizeCode(raw: string): string {
  return raw.trim().replace(/\s+/g, "").toUpperCase();
}

// "other" is usually a shelf label (look it up in ShelfLocation) or a typo.
export function classifyScan(raw: string): ScanKind {
  const code = normalizeCode(raw);
  if (ITEM_RE.test(code)) return "item";
  if (BIN_RE.test(code)) return "bin";
  if (BOX_RE.test(code)) return "box";
  if (UPC_RE.test(code)) return "upc";
  return "other";
}

export function formatItemCode(n: number): string {
  return `${ITEM_CODE_PREFIX}${String(n).padStart(6, "0")}`;
}

export function formatBinCode(n: number): string {
  return `${BIN_CODE_PREFIX}${String(n).padStart(4, "0")}`;
}

export function formatBoxCode(n: number): string {
  return `${BOX_CODE_PREFIX}${String(n).padStart(3, "0")}`;
}

// The number inside a code, e.g. 42 for "BN0042". null if it isn't one.
export function codeNumber(code: string, prefix: string): number | null {
  const n = normalizeCode(code);
  if (!n.startsWith(prefix)) return null;
  const digits = n.slice(prefix.length);
  return /^\d+$/.test(digits) ? Number(digits) : null;
}
