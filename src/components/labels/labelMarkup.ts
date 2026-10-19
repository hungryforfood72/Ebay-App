import type { CodeLabelPayload, ItemLabelPayload, PrintJobKind, PrintJobPayload } from "@/lib/warehouse/types";
import { barcodeSvg } from "./barcode";

// The 2" x 1" labels as HTML strings. Strings (not React) because the same
// markup has to go into a bare print iframe that has none of the app's CSS
// or React; LabelPreview renders the same strings on screen. Plain inline
// CSS in inches and points only, black on white, no Tailwind.

export const LABEL_KINDS: PrintJobKind[] = ["item", "bin", "shelf", "box", "dud", "sort"];

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
.wl-bad {
  font-size: 9pt;
  font-weight: 700;
}
`;

// Page setup for printing: one label per page, sized to the Rollo's 2x1
// stock, no margins (also keeps Chrome from adding its date/URL header).
export const LABEL_PRINT_CSS = `
@page { size: 2in 1in; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.wl-label { page-break-after: always; break-after: page; }
.wl-label:last-child { page-break-after: auto; break-after: auto; }
`;

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

function itemLabelHtml(p: ItemLabelPayload): string {
  // 0.34" of bars leaves room for the code, two lines of name and the
  // meta line inside 1" (adds up to about 0.95").
  const bars = barcodeSvg(p.code, 0.34);
  if (!bars) return badLabel(p.code);
  const meta = itemMetaLine(p);
  return (
    `<div class="wl-label">` +
    `<div class="wl-bars">${bars.svg}</div>` +
    `<div class="wl-code">${esc(p.code)}</div>` +
    (p.name ? `<div class="wl-name">${esc(p.name)}</div>` : "") +
    (meta ? `<div class="wl-meta">${esc(meta)}</div>` : "") +
    `</div>`
  );
}

function codeLabelHtml(kind: PrintJobKind, p: CodeLabelPayload): string {
  const caption = p.caption?.trim() || defaultCaption(kind, p.code);
  // Shelf captions are just "Shelf " + the code, so the code line under
  // them would only repeat it.
  const showSub = caption !== p.code && caption !== defaultCaption(kind, p.code);
  const bars = barcodeSvg(p.code, showSub ? 0.4 : 0.46);
  if (!bars) return badLabel(p.code);
  return (
    `<div class="wl-label">` +
    `<div class="wl-bars">${bars.svg}</div>` +
    `<div class="wl-caption" style="font-size:${captionSize(caption)};max-height:${caption.length > 18 ? "20pt" : "24pt"}">${esc(caption)}</div>` +
    (showSub ? `<div class="wl-sub">${esc(p.code)}</div>` : "") +
    `</div>`
  );
}

// Dud and sort box labels: read from across the floor, so the box code is
// the big line (like a bin label) and the caption sits under it, small, up
// to two lines: the load for a dud box ("DUDS · 10/14/26 Pallet 2 ..."),
// just "SORT BOX" for a sort box (they're reused load to load).
function boxLabelHtml(p: CodeLabelPayload, fallbackCaption: string): string {
  const caption = p.caption?.trim() || fallbackCaption;
  // 0.32" of bars + 16pt code + two 8.5pt caption lines fits inside 1"
  // with the padding (about 0.85").
  const bars = barcodeSvg(p.code, 0.32);
  if (!bars) return badLabel(p.code);
  return (
    `<div class="wl-label">` +
    `<div class="wl-bars">${bars.svg}</div>` +
    `<div class="wl-caption" style="font-size:16pt;max-height:18pt">${esc(p.code)}</div>` +
    `<div class="wl-dud-caption">${esc(caption)}</div>` +
    `</div>`
  );
}

// One label's markup.
export function labelHtml(kind: PrintJobKind, payload: PrintJobPayload): string {
  if (kind === "item") return itemLabelHtml(payload as ItemLabelPayload);
  if (kind === "dud") return boxLabelHtml(payload as CodeLabelPayload, "DUDS");
  if (kind === "sort") return boxLabelHtml(payload as CodeLabelPayload, "SORT BOX");
  return codeLabelHtml(kind, payload as CodeLabelPayload);
}

// A whole printable document: every label repeated `copies` times, one per
// page, in order.
export function labelsDocument(labels: LabelSpec[]): string {
  const pages = labels
    .flatMap((l) => {
      const one = labelHtml(l.kind, l.payload);
      return Array.from({ length: Math.max(1, l.copies ?? 1) }, () => one);
    })
    .join("");
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title>` +
    `<style>${LABEL_CSS}${LABEL_PRINT_CSS}</style></head><body>${pages}</body></html>`
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
    };
    return { payload };
  }
  const caption = typeof p.caption === "string" && p.caption.trim() ? p.caption.trim().slice(0, 60) : undefined;
  const payload: CodeLabelPayload = caption ? { code, caption } : { code };
  return { payload };
}
