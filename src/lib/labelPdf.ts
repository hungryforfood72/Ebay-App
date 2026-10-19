import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";

// Reads eBay's bulk shipping-label PDF in the browser (Pick orders upload,
// see warehouse/shippingLabels.ts): each page as a print-ready PNG, plus
// its text and barcodes, so the server can find the tracking number on it.
// Client only.

export type LabelPdfPage = {
  page: number;
  widthIn: number;
  heightIn: number;
  text: string;
  barcodes: string[];
  png: string; // data URL
};

// 300 dpi is plenty for a 203 dpi Rollo. Capped so a letter-size page
// doesn't make a huge image.
const DPI = 300;
const MAX_SIDE_PX = 1800;

// A long run of digits or a UPS 1Z number: the page's text already has a
// tracking number, so there's no need to read barcodes.
const TRACKING_LIKE = /\d{18,}|1Z[0-9A-Z]{16}/i;

export async function readLabelPdf(file: File, onPage?: (done: number, total: number) => void): Promise<LabelPdfPage[]> {
  const pdfjs = await import("pdfjs-dist");
  // Copied into public/ on install (scripts/copy-pdf-worker.mjs).
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: LabelPdfPage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(DPI / 72, MAX_SIDE_PX / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("This browser can't draw the PDF.");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const content = await page.getTextContent();
      const text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
      const barcodes = TRACKING_LIKE.test(text.replace(/\s+/g, "")) ? [] : readBarcodes(ctx, canvas.width, canvas.height);

      pages.push({
        page: n,
        widthIn: base.width / 72,
        heightIn: base.height / 72,
        text,
        barcodes,
        png: canvas.toDataURL("image/png"),
      });
      page.cleanup();
      onPage?.(n, doc.numPages);
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

// Every 1D barcode on the page. The reader returns one barcode per image
// and a label has several (UPS: a ZIP barcode and the tracking one), so it
// reads overlapping bands top to bottom, plus the whole page.
function readBarcodes(ctx: CanvasRenderingContext2D, width: number, height: number): string[] {
  const reader = new MultiFormatReader();
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);

  const found = new Set<string>();
  const decode = (top: number, h: number) => {
    const img = ctx.getImageData(0, top, width, h).data;
    const lum = new Uint8ClampedArray(width * h);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (img[i] * 299 + img[i + 1] * 587 + img[i + 2] * 114) / 1000;
    try {
      const result = reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, width, h))));
      found.add(result.getText());
    } catch {
      // Nothing readable in this band.
    }
  };
  const bands = 8;
  const bandH = Math.round(height / bands);
  for (let b = 0; b < bands * 2 - 1; b++) {
    const top = Math.round((b * bandH) / 2);
    decode(top, Math.min(bandH, height - top));
  }
  decode(0, height);
  return [...found];
}
