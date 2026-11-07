import {
  DEFAULT_LABEL_SIZE,
  LABEL_SIZES,
  type CodeLabelPayload,
  type ItemLabelPayload,
  type LabelSize,
  type PrintJobKind,
  type PrintJobPayload,
} from "@/lib/warehouse/types";
import { dudBoxName, showBoxNumber, sortBoxName } from "@/lib/warehouse/codes";
import { barcodeSvg } from "./barcode";
import { qrSvg } from "./qr";

// The 2" x 1" labels as HTML strings (bigger stock gets the same label,
// zoomed to fill it: labelsDocument). Strings (not React) because the same
// markup has to go into a bare print iframe that has none of the app's CSS
// or React; LabelPreview renders the same strings on screen. Plain inline
// CSS in inches and points only, black on white, no Tailwind.

export const LABEL_KINDS: PrintJobKind[] = ["item", "bin", "shelf", "box", "dud", "sort", "showbox"];

export function isLabelKind(v: unknown): v is PrintJobKind {
  return typeof v === "string" && (LABEL_KINDS as string[]).includes(v);
}

export type LabelSpec = { kind: PrintJobKind; payload: PrintJobPayload; copies?: number };

// Class names are prefixed so the preview can share a page with Tailwind
// without either one restyling the other.
export const LABEL_CSS = `
.wl-label {
  box-sizing: border-box;
  width: 2in;
  height: 1in;
  padding: 0.04in 0.08in;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #fff;
  color: #000;
  font-family: Arial, Helvetica, sans-serif;
  text-align: center;
  line-height: 1.1;
}
.wl-label * { box-sizing: border-box; }
.wl-bars { flex: none; }
.wl-code {
  margin-top: 1pt;
  font-family: "Consolas", "Courier New", monospace;
  font-weight: 700;
  font-size: 10pt;
  letter-spacing: 0.5pt;
  line-height: 1;
}
.wl-name {
  margin-top: 2pt;
  width: 100%;
  font-size: 7pt;
  line-height: 8pt;
  max-height: 16pt;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.wl-meta {
  margin-top: 1pt;
  width: 100%;
  font-size: 7pt;
  font-weight: 700;
  line-height: 8pt;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wl-shop {
  margin-left: 4pt;
  padding: 0 2pt;
  background: #000;
  color: #fff;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 6.5pt;
  letter-spacing: 0;
  vertical-align: 1pt;
}
.wl-caption {
  margin-top: 2pt;
  width: 100%;
  font-weight: 700;
  line-height: 1.05;
  overflow: hidden;
  word-break: break-word;
}
.wl-sub {
  margin-top: 1pt;
  font-family: "Consolas", "Courier New", monospace;
  font-size: 7pt;
  line-height: 1;
}
.wl-dud-caption {
  margin-top: 1pt;
  width: 100%;
  font-size: 7.5pt;
  font-weight: 700;
  line-height: 8.5pt;
  max-height: 17pt;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.wl-box {
  flex-direction: row;
  justify-content: flex-start;
  gap: 0.06in;
  text-align: left;
}
.wl-box-qr { flex: none; }
.wl-box-text {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.wl-box-name {
  font-size: 15pt;
  font-weight: 700;
  line-height: 1;
  overflow-wrap: anywhere;
}
.wl-show-kicker {
  font-size: 8pt;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.3pt;
}
.wl-show-number {
  font-size: 34pt;
  font-weight: 700;
  line-height: 0.95;
}
.wl-box-title {
  margin-top: 3pt;
  font-size: 7.5pt;
  font-weight: 700;
  line-height: 8.5pt;
  max-height: 34pt;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.wl-bad {
  font-size: 9pt;
  font-weight: 700;
}
`;

// Page setup for printing: one label per page, sized to the station's
// label stock, no margins (also keeps Chrome from adding its date/URL
// header). Each label sits centered on its page.
export function labelPrintCss(size: LabelSize = DEFAULT_LABEL_SIZE): string {
  const { width, height } = LABEL_SIZES[size];
  return `
@page { size: ${width}in ${height}in; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.wl-page {
  width: ${width}in;
  height: ${height}in;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  page-break-after: always;
  break-after: page;
}
.wl-page:last-child { page-break-after: auto; break-after: auto; }
`;
}

// How much the 2x1 label grows to fill the stock: 1.125 on 2.25x1.25,
// 2 on 4x6 (a 4x2 label across the middle of the page).
export function labelZoom(size: LabelSize = DEFAULT_LABEL_SIZE): number {
  const { width, height } = LABEL_SIZES[size];
  return Math.min(width / 2, height / 1);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CONDITION_TEXT: Record<string, string> = {
  new: "New",
  new_other: "Open box",
  used: "Used",
  for_parts: "For parts",
};

// The item's ItemCondition enum value, or whatever text the caller sent.
function conditionText(condition: string): string {
  const known = CONDITION_TEXT[condition.toLowerCase()];
  if (known) return known;
  // "USED_GOOD" -> "Used good"
  if (/^[A-Z0-9_]+$/.test(condition)) {
    const words = condition.toLowerCase().replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return condition;
}

// "3-PK · EXP 03/2027 · New", skipping whatever isn't known. A pack of 1
// is just a single item, not worth the space.
export function itemMetaLine(p: Pick<ItemLabelPayload, "packSize" | "expiration" | "condition">): string {
  const parts: string[] = [];
  if (p.packSize && p.packSize > 1) parts.push(`${p.packSize}-PK`);
  if (p.expiration) parts.push(`EXP ${p.expiration}`);
  if (p.condition) parts.push(conditionText(p.condition));
  return parts.join(" · ");
}

// The caption printed under a bin/shelf/box barcode when the caller didn't
// send one.
export function defaultCaption(kind: PrintJobKind, code: string): string {
  return kind === "shelf" ? `Shelf ${code}` : code;
}

// Bigger text for short captions ("BN0001"), smaller for long box names.
function captionSize(text: string): string {
  if (text.length <= 8) return "20pt";
  if (text.length <= 12) return "16pt";
  if (text.length <= 18) return "12pt";
  return "9pt";
}

function badLabel(code: string): string {
  return `<div class="wl-label"><div class="wl-bad">Can't make a barcode for "${esc(code)}"</div></div>`;
}

function itemLabelHtml(p: ItemLabelPayload, zoom: number): string {
  // 0.34" of bars leaves room for the code, two lines of name and the
  // meta line inside 1" (adds up to about 0.95").
  const bars = barcodeSvg(p.code, 0.34, zoom);
  if (!bars) return badLabel(p.code);
  const meta = itemMetaLine(p);
  return (
    `<div class="wl-label">` +
    `<div class="wl-bars">${bars.svg}</div>` +
    // Whatnot only: a black tag next to the code, so it goes to a Whatnot
    // bin (Cristian, 2026-11-03). Beside the code, not a line of its own:
    // the 1" label has no room for another line.
    // Giveaway stock (Cristian, 2026-11-07) says GIVEAWAY instead: it goes
    // in a giveaway bin, not with the auctions.
    `<div class="wl-code">${esc(p.code)}${p.giveaway ? `<span class="wl-shop">GIVEAWAY</span>` : p.whatnot ? `<span class="wl-shop">WHATNOT</span>` : ""}</div>` +
    (p.name ? `<div class="wl-name">${esc(p.name)}</div>` : "") +
    (meta ? `<div class="wl-meta">${esc(meta)}</div>` : "") +
    `</div>`
  );
}

function codeLabelHtml(kind: PrintJobKind, p: CodeLabelPayload, zoom: number): string {
  const caption = p.caption?.trim() || defaultCaption(kind, p.code);
  // Shelf captions are just "Shelf " + the code, so the code line under
  // them would only repeat it.
  const showSub = caption !== p.code && caption !== defaultCaption(kind, p.code);
  const bars = barcodeSvg(p.code, showSub ? 0.4 : 0.46, zoom);
  if (!bars) return badLabel(p.code);
  return (
    `<div class="wl-label">` +
    `<div class="wl-bars">${bars.svg}</div>` +
    `<div class="wl-caption" style="font-size:${captionSize(caption)};max-height:${caption.length > 18 ? "20pt" : "24pt"}">${esc(caption)}</div>` +
    (showSub ? `<div class="wl-sub">${esc(p.code)}</div>` : "") +
    `</div>`
  );
}

// Dud and sort box labels (QR since 2026-11-01): the QR on the left (it
// carries the load and the box number, see codes.ts), and what people read
// on the right: "SORT BOX 3" / "DUD BOX 3" big, the load's title under it.
// A box from before the QR labels shows its old code (SB0001) as the name,
// since that's what everyone already calls it. caption = the load's title.
function boxLabelHtml(p: CodeLabelPayload, name: string, zoom: number): string {
  const qr = qrSvg(p.code, 0.88, zoom);
  if (!qr) return badLabel(p.code);
  return (
    `<div class="wl-label wl-box">` +
    `<div class="wl-box-qr">${qr}</div>` +
    `<div class="wl-box-text">` +
    `<div class="wl-box-name">${esc(name.toUpperCase())}</div>` +
    (p.caption?.trim() ? `<div class="wl-box-title">${esc(p.caption.trim())}</div>` : "") +
    `</div>` +
    `</div>`
  );
}

// A Whatnot show box (Cristian, 2026-11-07): the QR on the left (WS-23),
// "WHATNOT SHOW BOX" and the number as big as it fits on the right, so the
// runner finds box 23 from across the table.
function showBoxLabelHtml(p: CodeLabelPayload, zoom: number): string {
  const n = showBoxNumber(p.code);
  const qr = qrSvg(p.code, 0.88, zoom);
  if (!qr || n == null) return badLabel(p.code);
  return (
    `<div class="wl-label wl-box">` +
    `<div class="wl-box-qr">${qr}</div>` +
    `<div class="wl-box-text">` +
    `<div class="wl-show-kicker">WHATNOT SHOW BOX</div>` +
    `<div class="wl-show-number">${n}</div>` +
    `</div>` +
    `</div>`
  );
}

// One label's markup, laid out at 2" x 1". zoom = the box it goes in is
// CSS-zoomed by this much (labelZoom), so the bars are sized to still land
// on whole printer dots.
function labelBody(kind: PrintJobKind, payload: PrintJobPayload, zoom: number): string {
  if (kind === "item") return itemLabelHtml(payload as ItemLabelPayload, zoom);
  if (kind === "dud") return boxLabelHtml(payload as CodeLabelPayload, dudBoxName((payload as CodeLabelPayload).code), zoom);
  if (kind === "sort") return boxLabelHtml(payload as CodeLabelPayload, sortBoxName((payload as CodeLabelPayload).code), zoom);
  if (kind === "showbox") return showBoxLabelHtml(payload as CodeLabelPayload, zoom);
  return codeLabelHtml(kind, payload as CodeLabelPayload, zoom);
}

// One 2" x 1" label's markup.
export function labelHtml(kind: PrintJobKind, payload: PrintJobPayload): string {
  return labelBody(kind, payload, 1);
}

// A whole printable document for the station's label stock: every label
// repeated `copies` times, one per page, in order, grown to fill the page.
export function labelsDocument(labels: LabelSpec[], size: LabelSize = DEFAULT_LABEL_SIZE): string {
  const zoom = labelZoom(size);
  const pages = labels
    .flatMap((l) => {
      const label = labelBody(l.kind, l.payload, zoom);
      const one = `<div class="wl-page">${zoom === 1 ? label : `<div style="zoom:${zoom}">${label}</div>`}</div>`;
      return Array.from({ length: Math.max(1, l.copies ?? 1) }, () => one);
    })
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title>` +
    `<style>${LABEL_CSS}${labelPrintCss(size)}</style></head><body>${pages}</body></html>`
  );
}

// Checks a payload from the API is the right shape for its kind, so a bad
// request fails when it's queued instead of printing a broken label.
// Returns a cleaned copy, or an error message.
export function cleanLabelPayload(
  kind: PrintJobKind,
  raw: unknown
): { payload: PrintJobPayload } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "payload is required." };
  const p = raw as Record<string, unknown>;
  const code = typeof p.code === "string" ? p.code.trim() : "";
  if (!code) return { error: "payload.code is required." };
  if (code.length > 40) return { error: "That code is too long for a label." };
  if (!barcodeSvg(code, 0.4)) return { error: `"${code}" can't be printed as a barcode.` };

  if (kind === "item") {
    const packSize = p.packSize == null || p.packSize === "" ? null : Number(p.packSize);
    if (packSize !== null && (!Number.isInteger(packSize) || packSize < 1)) {
      return { error: "payload.packSize must be a whole number or null." };
    }
    const payload: ItemLabelPayload = {
      code,
      name: typeof p.name === "string" ? p.name.trim().slice(0, 200) : "",
      packSize,
      expiration: typeof p.expiration === "string" && p.expiration.trim() ? p.expiration.trim() : null,
      condition: typeof p.condition === "string" && p.condition.trim() ? p.condition.trim() : null,
      ...(p.whatnot === true ? { whatnot: true } : {}),
      ...(p.giveaway === true ? { giveaway: true } : {}),
    };
    return { payload };
  }
  if (kind === "showbox" && showBoxNumber(code) == null) return { error: `"${code}" isn't a show box code.` };
  const caption = typeof p.caption === "string" && p.caption.trim() ? p.caption.trim().slice(0, 60) : undefined;
  const payload: CodeLabelPayload = caption ? { code, caption } : { code };
  return { payload };
}
