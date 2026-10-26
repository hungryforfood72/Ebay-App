"use client";

import { BarcodeFormat, EncodeHintType, QRCodeWriter } from "@zxing/library";
import { useMemo } from "react";

// A QR code drawn on a screen to be scanned by the handheld (the station PC's
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
