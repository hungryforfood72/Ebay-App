// Two liquidation suppliers, two different CSV formats. Detected from the
// header row (exact known column names) rather than guessed — with only two
// known formats, string matching is both simpler and more reliable than an
// AI guess, and an unrecognized header fails loudly instead of silently
// mis-parsing.

export type ManifestSupplierKey = "bstock" | "liquidation_com" | "unknown";

export type ParsedManifestLine = {
  supplierSku: string | null;
  upc: string | null;
  description: string;
  expectedQuantity: number;
  retailPrice: number;
  extendedRetail: number;
  condition: string | null;
  category: string | null;
  subcategory: string | null;
};

export type ParsedManifest = {
  supplier: ManifestSupplierKey;
  lines: ParsedManifestLine[];
};

// Minimal RFC4180-ish line splitter: quoted fields, embedded commas inside
// quotes, and "" as an escaped quote — all these two supplier formats use.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  fields.push(cur);
  return fields;
}

// "$1,234.56" or "1,234" -> 1234.56 / 1234. Both suppliers use thousands
// separators on their totals rows, and Liquidation.com prefixes money with
// "$".
function parseNumber(raw: string): number {
  const cleaned = raw.replace(/[$,]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// Liquidation.com has shipped two layouts of the same export: the original
// ("Product", "Total Retail Price") and a newer one ("UPC" first, then
// "Product Description", ..., "Total Price") seen on 2026-09-26. Each
// column is looked up by whichever of its names the file uses.
const LIQUIDATION_COLUMNS = {
  product: ["Product", "Product Description"],
  qty: ["Quantity"],
  upc: ["UPC"],
  category: ["Category"],
  subcategory: ["Subcategory"],
  retailPrice: ["Retail Price"],
  extRetail: ["Total Retail Price", "Total Price"],
};

function indexOfAny(header: string[], names: string[]): number {
  for (const name of names) {
    const i = header.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

export function detectSupplier(headerLine: string): ManifestSupplierKey {
  const fields = parseCsvLine(headerLine).map((f) => f.trim());
  if (fields.includes("TCIN") && fields.includes("Pallet ID")) return "bstock";
  const hasLiquidationColumns = [
    LIQUIDATION_COLUMNS.product,
    LIQUIDATION_COLUMNS.qty,
    LIQUIDATION_COLUMNS.retailPrice,
    LIQUIDATION_COLUMNS.extRetail,
  ].every((names) => indexOfAny(fields, names) >= 0);
  if (hasLiquidationColumns) return "liquidation_com";
  return "unknown";
}

function parseBStock(lines: string[]): ParsedManifestLine[] {
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const col = {
    itemNo: idx("Item #"),
    description: idx("Item Description"),
    qty: idx("Qty"),
    unitRetail: idx("Unit Retail"),
    extRetail: idx("Ext. Retail"),
    upc: idx("UPC"),
    condition: idx("Condition"),
    category: idx("Category"),
    subcategory: idx("Subcategory"),
  };

  const out: ParsedManifestLine[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const description = (f[col.description] ?? "").trim();
    if (!description) continue; // guards against any trailing summary row
    out.push({
      supplierSku: (f[col.itemNo] ?? "").trim() || null,
      upc: (f[col.upc] ?? "").trim() || null,
      description,
      expectedQuantity: Math.round(parseNumber(f[col.qty] ?? "0")),
      retailPrice: parseNumber(f[col.unitRetail] ?? "0"),
      extendedRetail: parseNumber(f[col.extRetail] ?? "0"),
      condition: (f[col.condition] ?? "").trim() || null,
      category: (f[col.category] ?? "").trim() || null,
      subcategory: (f[col.subcategory] ?? "").trim() || null,
    });
  }
  return out;
}

// Some newer-layout descriptions arrive quoted twice over — wrapped in a
// literal extra pair of quotes with their inner quotes escaped again
// ("""Ziploc Sandwich Bags, 5.88"""" Width""" in the raw CSV). Undo the
// second layer so it reads like every other line.
function unwrapQuoted(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"').trim();
  }
  return value;
}

function parseLiquidationCom(lines: string[]): ParsedManifestLine[] {
  const header = parseCsvLine(lines[0]).map((f) => f.trim());
  const col = Object.fromEntries(
    Object.entries(LIQUIDATION_COLUMNS).map(([key, names]) => [key, indexOfAny(header, names)])
  ) as Record<keyof typeof LIQUIDATION_COLUMNS, number>;

  const out: ParsedManifestLine[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const description = unwrapQuoted((f[col.product] ?? "").trim());
    // The file ends with a totals row (aggregate quantity and dollar total)
    // — not a real line item. The original layout leaves its description
    // blank; the newer one fills the text columns with "?".
    if (!description || description === "?") continue;
    const upc = (f[col.upc] ?? "").trim();
    out.push({
      supplierSku: null,
      upc: upc && upc !== "?" ? upc : null,
      description,
      expectedQuantity: Math.round(parseNumber(f[col.qty] ?? "0")),
      retailPrice: parseNumber(f[col.retailPrice] ?? "0"),
      extendedRetail: parseNumber(f[col.extRetail] ?? "0"),
      condition: null,
      category: (f[col.category] ?? "").trim() || null,
      subcategory: (f[col.subcategory] ?? "").trim() || null,
    });
  }
  return out;
}

export function parseManifestCsv(content: string): ParsedManifest {
  const lines = content.replace(/^﻿/, "").split(/\r?\n/);
  const headerLine = lines[0] ?? "";
  const supplier = detectSupplier(headerLine);

  if (supplier === "bstock") return { supplier, lines: parseBStock(lines) };
  if (supplier === "liquidation_com") return { supplier, lines: parseLiquidationCom(lines) };
  return { supplier: "unknown", lines: [] };
}
