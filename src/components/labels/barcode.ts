import JsBarcode from "jsbarcode";

// Code 128 barcodes drawn as plain SVG markup for the 2" x 1" labels the
// station's Rollo prints. We don't let JsBarcode draw the SVG itself: we
// want every bar to land on whole printer dots, so we take its encoded
// bars and size them ourselves. Pure string output, so it works the same
// in the print iframe, an on-screen preview, or a node test.
//
// Sizing, at the Rollo's 203 dpi: a 2" label is 406 dots wide. Code 128
// needs a blank "quiet zone" of 10 bar-widths on each side or scanners
// struggle. ES000123 is 101 bar-widths, so (101 + 20) * 3 dots = 363 fits
// with room to spare for the label sitting a little off-center. Longer
// codes step down to 2 dots (the usual minimum for a thermal printer),
// then 1, and anything longer than that just shrinks to fit.

export const PRINTER_DPI = 203;
const QUIET_MODULES = 10;
// A bit under 406 so a label that feeds slightly crooked still keeps its
// quiet zones on the paper.
const USABLE_WIDTH_DOTS = 380;

export type BarcodeSvg = {
  svg: string;
  // The bars alone, without quiet zones.
  widthIn: number;
  // Bar width picked, in printer dots (0 = shrunk to fit).
  moduleDots: number;
};

// "1101001000..." for the code, or null if Code 128 can't encode it
// (non-ASCII characters).
export function code128Bits(code: string): string | null {
  const target: { encodings?: { data: string }[] } = {};
  let valid = true;
  JsBarcode(target, code, {
    format: "CODE128",
    valid: (ok: boolean) => {
      valid = ok;
    },
  });
  if (!valid || !target.encodings?.length) return null;
  return target.encodings.map((e) => e.data).join("");
}

export function barcodeSvg(code: string, heightIn: number): BarcodeSvg | null {
  const bits = code128Bits(code);
  if (!bits) return null;
  const modules = bits.length;

  const moduleDots = [3, 2, 1].find((d) => (modules + QUIET_MODULES * 2) * d <= USABLE_WIDTH_DOTS) ?? 0;
  const widthIn = moduleDots
    ? (modules * moduleDots) / PRINTER_DPI
    : (USABLE_WIDTH_DOTS * modules) / (modules + QUIET_MODULES * 2) / PRINTER_DPI;

  // One rect per run of black bars, in bar-width units (the viewBox), so
  // the browser scales whole bars rather than drawing hairlines.
  let rects = "";
  for (let i = 0; i < modules; ) {
    if (bits[i] !== "1") {
      i++;
      continue;
    }
    let j = i;
    while (j < modules && bits[j] === "1") j++;
    rects += `<rect x="${i}" y="0" width="${j - i}" height="1"/>`;
    i = j;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${modules} 1" preserveAspectRatio="none" ` +
    `shape-rendering="crispEdges" fill="#000" ` +
    `style="display:block;width:${widthIn.toFixed(4)}in;height:${heightIn}in">${rects}</svg>`;
  return { svg, widthIn, moduleDots };
}
