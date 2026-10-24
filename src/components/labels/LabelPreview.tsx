"use client";

import { DEFAULT_LABEL_SIZE, LABEL_SIZES, type LabelSize, type PrintJobKind, type PrintJobPayload } from "@/lib/warehouse/types";
import { cn } from "@/components/ui/cn";
import { LABEL_CSS, labelHtml, labelZoom } from "./labelMarkup";

// On-screen picture of a label, drawn from the exact markup the station
// prints, so what you see here is what comes out of the Rollo. Real size
// is 2" x 1" (192 x 96 CSS px), or the station's label size (`size`, the
// 2x1 label grown to fill it, close to how it prints); `scale` blows it up
// for readability.
export function LabelPreview({
  kind,
  payload,
  scale = 1,
  size = DEFAULT_LABEL_SIZE,
  className,
}: {
  kind: PrintJobKind;
  payload: PrintJobPayload;
  scale?: number;
  size?: LabelSize;
  className?: string;
}) {
  const { width, height } = LABEL_SIZES[size];
  // Real size can be 4x6; keep the preview about as big as a 2x1 one.
  const fit = scale / Math.max(1, labelZoom(size) / 1.25);
  const grow = labelZoom(size) * fit;
  return (
    <div
      className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-white shadow-sm", className)}
      style={{ width: `${width * fit}in`, height: `${height * fit}in` }}
    >
      <style>{LABEL_CSS}</style>
      <div style={{ width: `${2 * grow}in`, height: `${1 * grow}in` }}>
        <div
          style={{ transform: `scale(${grow})`, transformOrigin: "top left", width: "2in", height: "1in" }}
          dangerouslySetInnerHTML={{ __html: labelHtml(kind, payload) }}
        />
      </div>
    </div>
  );
}
