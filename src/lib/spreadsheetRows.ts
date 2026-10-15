// Browser-only: turns an uploaded .xlsx or .csv into a plain grid of cell
// strings for the custom-column manifest mapper. An .xlsx is a zip of XML
// files, and the browser can inflate zip entries natively
// (DecompressionStream), so this reads the first sheet without pulling in a
// spreadsheet library.

import { parseCsvLine } from "./manifestParsers";

export type SheetGrid = {
  rows: string[][];
  // 0-based columns Excel has hidden. The Medical Supplies manifest
  // (2026-10-15) hides A and J–Q, so the columns Cristian sees as "B" and
  // "I" are really C and R — the mapper labels columns by header name, not
  // letter, and skips hidden ones when guessing.
  hiddenColumns: number[];
};

export async function readSpreadsheet(file: File): Promise<SheetGrid> {
  if (/\.xlsx$/i.test(file.name)) return readXlsx(await file.arrayBuffer());
  if (/\.xls$/i.test(file.name)) {
    throw new Error("That's an old .xls file. Open it in Excel and Save As .xlsx (or .csv), then upload that.");
  }
  const text = (await file.text()).replace(/^﻿/, "");
  return { rows: text.split(/\r?\n/).map(parseCsvLine), hiddenColumns: [] };
}

// --- zip ---------------------------------------------------------------

async function readZipEntries(buf: ArrayBuffer): Promise<Map<string, () => Promise<string>>> {
  const view = new DataView(buf);
  // End of central directory record: last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That file isn't a valid .xlsx.");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  const entries = new Map<string, () => Promise<string>>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    entries.set(name, async () => {
      // Sizes come from the central directory; the local header's name and
      // extra lengths can differ from it, so re-read them there.
      const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const raw = new Uint8Array(buf, dataStart, compressedSize);
      if (method === 0) return decoder.decode(raw);
      if (method !== 8) throw new Error("This .xlsx uses a compression the app can't read. Save it as .csv instead.");
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).text();
    });
  }
  return entries;
}

// --- xlsx --------------------------------------------------------------

function xml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

// Namespace-agnostic: Excel writes the default namespace, "strict" files
// and some exporters use a prefix.
function byTag(parent: Document | Element, tag: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS("*", tag));
}

function columnIndex(cellRef: string): number {
  const letters = cellRef.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Excel stores numbers as doubles, so a price can come back as
// "12.300000000000001" and a long UPC as "6.10075E+11". 15 significant
// digits is Excel's own display precision.
function cleanNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (Number.isInteger(n) && Math.abs(n) < Number.MAX_SAFE_INTEGER) return n.toFixed(0);
  return String(Number(n.toPrecision(15)));
}

async function readXlsx(buf: ArrayBuffer): Promise<SheetGrid> {
  const entries = await readZipEntries(buf);
  const read = async (path: string) => {
    const get = entries.get(path);
    return get ? get() : null;
  };

  // First sheet in workbook order -> its file via the workbook's rels.
  const workbook = await read("xl/workbook.xml");
  if (!workbook) throw new Error("That file isn't a valid .xlsx.");
  const firstSheet = byTag(xml(workbook), "sheet")[0];
  const relId =
    firstSheet?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ??
    firstSheet?.getAttribute("r:id");
  let sheetPath = "xl/worksheets/sheet1.xml";
  const rels = await read("xl/_rels/workbook.xml.rels");
  if (rels && relId) {
    const target = byTag(xml(rels), "Relationship")
      .find((r) => r.getAttribute("Id") === relId)
      ?.getAttribute("Target");
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  }

  const sharedStrings: string[] = [];
  const ssText = await read("xl/sharedStrings.xml");
  if (ssText) {
    for (const si of byTag(xml(ssText), "si")) {
      // Text runs only — skip <rPh> phonetic hints, which also hold <t>.
      sharedStrings.push(
        byTag(si, "t")
          .filter((t) => t.parentElement?.localName !== "rPh")
          .map((t) => t.textContent ?? "")
          .join("")
      );
    }
  }

  const sheetText = await read(sheetPath);
  if (!sheetText) throw new Error("Couldn't find a worksheet in that .xlsx.");
  const sheet = xml(sheetText);

  const hiddenColumns: number[] = [];
  for (const col of byTag(sheet, "col")) {
    if (col.getAttribute("hidden") !== "1" && col.getAttribute("hidden") !== "true") continue;
    const min = Number(col.getAttribute("min"));
    const max = Math.min(Number(col.getAttribute("max")), 200);
    for (let c = min; c <= max; c++) hiddenColumns.push(c - 1);
  }

  const rows: string[][] = [];
  for (const row of byTag(sheet, "row")) {
    const rowIndex = Number(row.getAttribute("r")) - 1;
    const cells: string[] = [];
    let nextCol = 0;
    for (const c of Array.from(row.children).filter((el) => el.localName === "c")) {
      const ref = c.getAttribute("r");
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      const type = c.getAttribute("t");
      const v = Array.from(c.children).find((el) => el.localName === "v")?.textContent ?? "";
      let value: string;
      if (type === "s") value = sharedStrings[Number(v)] ?? "";
      else if (type === "inlineStr") value = byTag(c, "t").map((t) => t.textContent ?? "").join("");
      else if (type === "str" || type === "e") value = v;
      else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
      else value = v === "" ? "" : cleanNumber(v);
      cells[col] = value;
    }
    rows[Number.isFinite(rowIndex) && rowIndex >= 0 ? rowIndex : rows.length] = Array.from(cells, (x) => x ?? "");
  }
  return { rows: Array.from(rows, (r) => r ?? []), hiddenColumns };
}
