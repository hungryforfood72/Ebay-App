// Manifests from suppliers other than BStock / Liquidation.com: instead of
// a hardcoded format, Cristian points at which column holds what (the
// mapper guesses first, from the header names). Pure functions, shared by
// the upload UI (preview) and nothing else — the API receives the already
// mapped lines.

import { parseNumber, type ParsedManifestLine } from "./manifestParsers";

export type ColumnMapping = {
  headerRow: number; // 0-based row holding the column titles
  description: number | null;
  quantity: number | null;
  // Optional multiplier for manifests whose quantity counts cases: units =
  // quantity × this column (e.g. Qty 23 cases × Case/Pack 5 = 115).
  packSize: number | null;
  // Pieces in one box as eBay sells it, so the Analyzer can price boxes
  // instead of loose pieces (see ManifestLine.piecesPerBox). Usually the
  // same Case/Pack column, whether or not quantity is already in pieces.
  piecesPerBox: number | null;
  upc: number | null;
  sku: number | null;
  unitRetail: number | null;
  totalRetail: number | null;
  category: number | null;
  condition: number | null;
  // Columns tacked onto the description, e.g. "Size" — two lines with the
  // same description but a 2 1/4" vs 4" flange are different products.
  extraDescription: number[];
  // Some suppliers drop the UPC's last (check) digit: the Medical Supplies
  // manifest lists Hollister 14204 as 61007514204, real UPC 610075142040.
  fixUpcCheckDigit: boolean;
};

export type MappableField = Exclude<keyof ColumnMapping, "headerRow" | "extraDescription" | "fixUpcCheckDigit">;

const cell = (row: string[] | undefined, col: number | null) => (col == null ? "" : (row?.[col] ?? "").trim());

const isBlankish = (v: string) => !v || /^(n\/?a|none|null|\?|-+)$/i.test(v);

export function columnLetter(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// The header row is the one with the most text (non-numeric) cells near
// the top — skips title rows like "Medical Inventory" above it.
export function guessHeaderRow(rows: string[][]): number {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const score = (rows[i] ?? []).filter((v) => v.trim() && !Number.isFinite(Number(v.replace(/[$,]/g, "")))).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

// Two-line headers ("Case /" over "Pack", "Total" over "Pieces") read as
// one label. Only when the row above looks like part of the header (2+
// filled cells) — not a lone title cell.
export function columnLabels(rows: string[][], headerRow: number): string[] {
  const header = rows[headerRow] ?? [];
  const above = headerRow > 0 ? (rows[headerRow - 1] ?? []) : [];
  const useAbove = above.filter((v) => v.trim()).length >= 2;
  const width = Math.max(...rows.slice(headerRow, headerRow + 50).map((r) => r.length), 0);
  return Array.from({ length: width }, (_, i) => {
    const label = [useAbove ? above[i] : "", header[i]]
      .map((v) => (v ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ");
    return label || `Column ${columnLetter(i)}`;
  });
}

// First filled value under the header, so a dropdown can show what's
// actually in the column.
export function sampleValue(rows: string[][], headerRow: number, col: number): string {
  for (const row of rows.slice(headerRow + 1)) {
    const v = (row[col] ?? "").trim();
    if (v) return v;
  }
  return "";
}

const PATTERNS: Record<string, RegExp> = {
  description: /desc|product name|item name|title/,
  descriptionFallback: /^(product|name|item)$/,
  totalUnits: /total (pieces|pcs|units|qty|quantity|count)|^(pieces|pcs|units|total units)$/,
  quantity: /qty|quantity|qnty|^count$/,
  quantityExclude: /orig|inv|pallet|order|ship|per|total|case/,
  quantityCases: /^(cases|case count|# of cases|cs)$/,
  packSize: /case ?\/? ?pack|^pack$|pack size|units? per|per case|casepack|case qty|inner/,
  upc: /upc|ean|gtin|barcode/,
  sku: /item ?#|item (no|num|number)|sku|part ?#|part (no|number)|mpn|model|tcin|asin/,
  totalRetail: /(ext|extended|total) ?(retail|msrp|value)/,
  unitRetail: /retail|msrp|unit price|^price$/,
  category: /categ|dept|department/,
  condition: /condition|grade/,
  extra: /^(size|color|colour)$/,
};

export function guessMapping(rows: string[][], headerRow: number, hiddenColumns: number[]): ColumnMapping {
  const labels = columnLabels(rows, headerRow).map((l) => l.toLowerCase().replace(/[.:]/g, "").replace(/\s+/g, " ").trim());
  const hidden = new Set(hiddenColumns);
  const taken = new Set<number>();
  const find = (re: RegExp, exclude?: RegExp): number | null => {
    const i = labels.findIndex((l, idx) => !hidden.has(idx) && !taken.has(idx) && re.test(l) && !(exclude && exclude.test(l)));
    if (i < 0) return null;
    taken.add(i);
    return i;
  };

  const upc = find(PATTERNS.upc);
  const totalRetail = find(PATTERNS.totalRetail);
  const unitRetail = find(PATTERNS.unitRetail, /total|ext|cost/);
  const description = find(PATTERNS.description) ?? find(PATTERNS.descriptionFallback);
  const sku = find(PATTERNS.sku);
  // A "Total Pieces" column already is the unit count; only fall back to
  // quantity × case pack when there isn't one.
  const totalUnits = find(PATTERNS.totalUnits);
  const quantity = totalUnits ?? find(PATTERNS.quantity, PATTERNS.quantityExclude) ?? find(PATTERNS.quantityCases);
  const packColumn = find(PATTERNS.packSize);
  const packSize = totalUnits == null && quantity != null ? packColumn : null;
  const category = find(PATTERNS.category);
  const condition = find(PATTERNS.condition);
  const extraDescription = labels.flatMap((l, i) => (!hidden.has(i) && !taken.has(i) && PATTERNS.extra.test(l) ? [i] : []));

  const mapping: ColumnMapping = {
    headerRow,
    description,
    quantity,
    packSize,
    piecesPerBox: packColumn,
    upc,
    sku,
    unitRetail,
    totalRetail,
    category,
    condition,
    extraDescription,
    fixUpcCheckDigit: false,
  };
  mapping.fixUpcCheckDigit = upcCheckDigitReport(rows, mapping).looksMissing;
  return mapping;
}

// --- UPCs --------------------------------------------------------------

function checkDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

function hasValidCheckDigit(code: string): boolean {
  return code.length >= 8 && checkDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

export function normalizeUpc(raw: string, fixCheckDigit: boolean): string | null {
  const v = raw.trim();
  if (isBlankish(v)) return null;
  const digits = v.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return v;
  if (digits.length <= 11) {
    if (fixCheckDigit && digits.length >= 6) {
      const body = digits.padStart(11, "0");
      return body + checkDigit(body);
    }
    // Excel drops leading zeros from numeric cells: a real 12-digit UPC
    // starting with 0 arrives as 11 digits.
    const padded = digits.padStart(12, "0");
    if (hasValidCheckDigit(padded)) return padded;
  }
  return digits;
}

// Short numeric UPCs that fail the barcode checksum about 9 times in 10
// (chance level) are missing their check digit, not just a leading zero.
export function upcCheckDigitReport(rows: string[][], mapping: ColumnMapping): { short: number; failing: number; looksMissing: boolean } {
  let short = 0;
  let failing = 0;
  if (mapping.upc != null) {
    for (const row of rows.slice(mapping.headerRow + 1)) {
      const digits = cell(row, mapping.upc).replace(/[\s-]/g, "");
      if (!/^\d{6,11}$/.test(digits)) continue;
      short++;
      if (!hasValidCheckDigit(digits.padStart(12, "0"))) failing++;
    }
  }
  return { short, failing, looksMissing: short >= 5 && failing / short > 0.6 };
}

// --- lines -------------------------------------------------------------

const TOTALS_ROW = /^(grand )?totals?:?$|^sub ?totals?:?$/i;

export function applyMapping(rows: string[][], mapping: ColumnMapping): ParsedManifestLine[] {
  if (mapping.description == null || mapping.quantity == null) return [];
  const out: ParsedManifestLine[] = [];
  for (const row of rows.slice(mapping.headerRow + 1)) {
    const base = cell(row, mapping.description).replace(/\s+/g, " ");
    if (isBlankish(base) || TOTALS_ROW.test(base)) continue;
    const extras = mapping.extraDescription.map((c) => cell(row, c).replace(/\s+/g, " ")).filter((v) => !isBlankish(v));
    const description = extras.length ? `${base} - ${extras.join(", ")}` : base;

    const qty = parseNumber(cell(row, mapping.quantity));
    const pack = mapping.packSize != null ? parseNumber(cell(row, mapping.packSize)) : 1;
    const units = Math.round(qty * (pack > 0 ? pack : 1));
    if (units <= 0) continue;

    const unitCol = mapping.unitRetail != null ? parseNumber(cell(row, mapping.unitRetail)) : null;
    const totalCol = mapping.totalRetail != null ? parseNumber(cell(row, mapping.totalRetail)) : null;
    const retailPrice = unitCol ?? (totalCol != null ? totalCol / units : 0);
    const extendedRetail = totalCol ?? retailPrice * units;

    const boxSize = mapping.piecesPerBox != null ? Math.round(parseNumber(cell(row, mapping.piecesPerBox))) : 0;
    const sku = cell(row, mapping.sku);
    out.push({
      supplierSku: isBlankish(sku) ? null : sku,
      upc: mapping.upc != null ? normalizeUpc(cell(row, mapping.upc), mapping.fixUpcCheckDigit) : null,
      description,
      expectedQuantity: units,
      retailPrice: Math.round(retailPrice * 100) / 100,
      extendedRetail: Math.round(extendedRetail * 100) / 100,
      condition: cell(row, mapping.condition) || null,
      category: cell(row, mapping.category) || null,
      subcategory: null,
      piecesPerBox: boxSize > 1 ? boxSize : null,
    });
  }
  return out;
}

// Identifies a supplier's layout so a saved mapping auto-applies the next
// time the same format is uploaded.
export function headerSignature(rows: string[][], headerRow: number): string {
  return columnLabels(rows, headerRow).join("|").toLowerCase();
}
