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

export function detectSupplier(headerLine: string): ManifestSupplierKey {
  const fields = parseCsvLine(headerLine).map((f) => f.trim());
  if (fields.includes("TCIN") && fields.includes("Pallet ID")) return "bstock";
  if (fields.includes("Product") && fields.includes("Total Retail Price")) return "liquidation_com";
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

function parseLiquidationCom(lines: string[]): ParsedManifestLine[] {
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const col = {
    product: idx("Product"),
    qty: idx("Quantity"),
    upc: idx("UPC"),
    category: idx("Category"),
    subcategory: idx("Subcategory"),
    retailPrice: idx("Retail Price"),
    extRetail: idx("Total Retail Price"),
  };

  const out: ParsedManifestLine[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const description = (f[col.product] ?? "").trim();
    // The file ends with a totals row (blank/whitespace Product, aggregate
    // quantity and dollar total) — not a real line item.
    if (!description) continue;
    out.push({
      supplierSku: null,
      upc: (f[col.upc] ?? "").trim() || null,
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
