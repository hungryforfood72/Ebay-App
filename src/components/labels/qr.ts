import { BarcodeFormat, EncodeHintType, QRCodeWriter } from "@zxing/library";
import { PRINTER_DPI } from "./barcode";

// QR codes drawn as plain SVG markup for the sort and dud box labels
// (Cristian, 2026-11-01: box codes carry the load, see codes.ts). Same idea
// as barcodeSvg: every module lands on whole printer dots so the thermal
// print stays crisp, and pure string output so it works in the print
// iframe, an on-screen preview, or a node test.

// Blank modules around the code. The spec asks for 4; the label's own
// white edge adds more, and the handheld's imager reads 2 fine.
const QUIET_MODULES = 2;

// sizeIn: the most room the code can take (a square), before zoom. zoom:
// the label is drawn inside a box CSS-zoomed by this much (labelsDocument).
export function qrSvg(text: string, sizeIn: number, zoom = 1): string | null {
  let matrix;
  try {
    const hints = new Map<EncodeHintType, unknown>([[EncodeHintType.MARGIN, 0]]);
    matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints);
  } catch {
    return null;
  }
  const n = matrix.getWidth();
  const total = n + QUIET_MODULES * 2;
  const maxDots = Math.floor(sizeIn * PRINTER_DPI * zoom);
  const moduleDots = Math.max(1, Math.floor(maxDots / total));
  const widthIn = (total * moduleDots) / PRINTER_DPI / zoom;

  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; ) {
      if (!matrix.get(x, y)) {
        x++;
        continue;
      }
      let end = x;
      while (end < n && matrix.get(end, y)) end++;
      path += `M${x + QUIET_MODULES} ${y + QUIET_MODULES}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" ` +
    `style="display:block;width:${widthIn.toFixed(4)}in;height:${widthIn.toFixed(4)}in">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
