"use client";

import type { PrintJobKind, PrintJobPayload } from "@/lib/warehouse/types";
import { cn } from "@/components/ui/cn";
import { LABEL_CSS, labelHtml } from "./labelMarkup";

// On-screen picture of a label, drawn from the exact markup the station
// prints, so what you see here is what comes out of the Rollo. Real size
// is 2" x 1" (192 x 96 CSS px); `scale` blows it up for readability.
export function LabelPreview({
  kind,
  payload,
  scale = 1,
  className,
}: {
  kind: PrintJobKind;
  payload: PrintJobPayload;
  scale?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("shrink-0 overflow-hidden rounded-md border border-border bg-white shadow-sm", className)}
      style={{ width: `${2 * scale}in`, height: `${1 * scale}in` }}
    >
      <style>{LABEL_CSS}</style>
      <div
        style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: "2in", height: "1in" }}
        dangerouslySetInnerHTML={{ __html: labelHtml(kind, payload) }}
      />
    </div>
  );
}
