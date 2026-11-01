// Barcode formats for warehouse mode. Each kind has its own prefix so any
// scan field can tell what was scanned without asking:
//   ES000123  item label (= the item's sku and eBay custom label)
//   BN0001    bin
//   BX001     box size
//   DB-1A2B3C4D-2  dud box 2 of a load (one manifest's duds, from the sort station)
//   SB-1A2B3C4D-2  sort box 2 of a load (good units sorted out of a load)
// Box codes are QR codes since 2026-11-01 (Cristian): the code carries the
// load (first 8 of its id) and the box's number within that load, so every
// load counts its boxes from 1 again and two loads never share a code.
// Boxes made before that keep their old codes (DB0001, SB0001) and labels.
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
export const DUD_BOX_CODE_PREFIX = "DB";
export const SORT_BOX_CODE_PREFIX = "SB";
// An oversized shelf's hidden bin (Bin.shelfBin): "OS-" + the shelf label.
// Never printed: people scan the shelf's own label.
export const SHELF_BIN_CODE_PREFIX = "OS-";

export function shelfBinCode(shelfLabel: string): string {
  return SHELF_BIN_CODE_PREFIX + normalizeCode(shelfLabel);
}

const ITEM_RE = /^ES\d{6,}$/;
const BIN_RE = /^BN\d{4,}$/;
const BOX_RE = /^BX\d{3,}$/;
const DUD_BOX_RE = /^DB(\d{4,}|-[0-9A-Z]{8}-\d+)$/;
const SORT_BOX_RE = /^SB(\d{4,}|-[0-9A-Z]{8}-\d+)$/;
const LOAD_BOX_RE = /^(SB|DB)-[0-9A-Z]{8}-(\d+)$/;
const UPC_RE = /^\d{8,14}$/;

export type ScanKind = "item" | "bin" | "box" | "dudbox" | "sortbox" | "upc" | "other";

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
  if (DUD_BOX_RE.test(code)) return "dudbox";
  if (SORT_BOX_RE.test(code)) return "sortbox";
  if (UPC_RE.test(code)) return "upc";
  return "other";
}

export function formatItemCode(n: number): string {
  return `${ITEM_CODE_PREFIX}${String(n).padStart(6, "0")}`;
}

export function formatBinCode(n: number): string {
  return `${BIN_CODE_PREFIX}${String(n).padStart(4, "0")}`;
}

// A box's QR code: prefix, the load's tag, its number within the load.
export function loadBoxCode(prefix: typeof SORT_BOX_CODE_PREFIX | typeof DUD_BOX_CODE_PREFIX, manifestId: string, n: number): string {
  return `${prefix}-${manifestId.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8).toUpperCase()}-${n}`;
}

// The box's number within its load (3 for "SB-1A2B3C4D-3"), or null for an
// old-style code (SB0001), which has no per-load number.
export function loadBoxNumber(code: string): number | null {
  const m = LOAD_BOX_RE.exec(normalizeCode(code));
  return m ? Number(m[2]) : null;
}

// The next box number for a load, given its boxes' codes: after the
// highest QR-style number, and after however many boxes it already has
// (old-style SB0001 boxes have no number of their own; on the 10/14 pallet
// SB0001-SB0010 are its first ten).
export function nextLoadBoxNumber(codes: string[]): number {
  return Math.max(codes.length, ...codes.map((c) => loadBoxNumber(c) ?? 0)) + 1;
}

// What people read for a box: "Sort Box 3" / "Dud Box 3", or the old code
// itself for a box from before the QR labels (that's what its label says).
export function sortBoxName(code: string): string {
  const n = loadBoxNumber(code);
  return n == null ? code : `Sort Box ${n}`;
}

export function dudBoxName(code: string): string {
  const n = loadBoxNumber(code);
  return n == null ? code : `Dud Box ${n}`;
}

// Short form for lists of sort boxes ("Box 2 x1 · Box 8 x3").
export function boxShortName(code: string): string {
  const n = loadBoxNumber(code);
  return n == null ? code : `Box ${n}`;
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
