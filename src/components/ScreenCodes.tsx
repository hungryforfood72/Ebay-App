"use client";

import { BarcodeFormat, EncodeHintType, QRCodeWriter } from "@zxing/library";
import { useMemo } from "react";
import { code128Bits } from "./labels/barcode";

// Codes drawn on a screen to be scanned by the handheld (the station PC's
// sign-in screen), not printed: sized in CSS pixels, square modules with
// crisp edges so the scanner's imager reads them straight off the monitor.

export function QrCode({ text, size, className }: { text: string; size: number; className?: string }) {
  const rects = useMemo(() => {
    const hints = new Map<EncodeHintType, unknown>([[EncodeHintType.MARGIN, 2]]);
    const matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints);
    const cells: string[] = [];
    for (let y = 0; y < matrix.getHeight(); y++) {
      for (let x = 0; x < matrix.getWidth(); x++) {
        if (matrix.get(x, y)) cells.push(`M${x} ${y}h1v1h-1z`);
      }
    }
    return { path: cells.join(""), width: matrix.getWidth() };
  }, [text]);
  return (
    <svg
      viewBox={`0 0 ${rects.width} ${rects.width}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label={`QR code ${text}`}
    >
      <rect width={rects.width} height={rects.width} fill="#fff" />
      <path d={rects.path} fill="#000" />
    </svg>
  );
}

// Code 128, for a scanner set up to read only 1D barcodes.
export function ScreenBarcode({ text, height, moduleWidth = 2, className }: { text: string; height: number; moduleWidth?: number; className?: string }) {
  const bits = useMemo(() => code128Bits(text), [text]);
  if (!bits) return null;
  const quiet = 10;
  const total = bits.length + quiet * 2;
  let rects = "";
  for (let i = 0; i < bits.length; ) {
    if (bits[i] !== "1") {
      i++;
      continue;
    }
    let j = i;
    while (j < bits.length && bits[j] === "1") j++;
    rects += `M${i + quiet} 0h${j - i}v1h-${j - i}z`;
    i = j;
  }
  return (
    <svg
      viewBox={`0 0 ${total} 1`}
      width={total * moduleWidth}
      height={height}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label={`Barcode ${text}`}
    >
      <rect width={total} height={1} fill="#fff" />
      <path d={rects} fill="#000" />
    </svg>
  );
}
