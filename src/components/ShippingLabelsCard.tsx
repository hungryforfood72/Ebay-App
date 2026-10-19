"use client";

import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { readLabelPdf } from "@/lib/labelPdf";
import type { LabelRow, PageMatch } from "@/lib/warehouse/shippingLabels";
import { ChevronDown, FileUp, LoaderCircle, Printer, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

// Pick orders: upload eBay's bulk shipping-label PDF, then scan each box's
// packing slip and its label prints (see warehouse/shippingLabels.ts).
export function ShippingLabelsCard({
  labels,
  onChanged,
  assigningId,
  onAssign,
  onReprint,
  busy,
}: {
  labels: LabelRow[] | null;
  onChanged: () => void;
  // An unmatched label waiting for its packing slip to be scanned.
  assigningId: string | null;
  onAssign: (id: string | null) => void;
  onReprint: (orderId: string) => void;
  busy: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function upload(file: File) {
    setError(null);
    setSummary(null);
    try {
      setProgress("Opening the PDF…");
      const pages = await readLabelPdf(file, (done, total) => setProgress(`Reading page ${done} of ${total}…`));
      if (pages.length === 0) throw new Error("That PDF has no pages.");

      setProgress(`Matching ${pages.length} label${pages.length === 1 ? "" : "s"} to orders…`);
      const res = await fetch("/api/ship/labels/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: pages.map((p) => ({ text: p.text, barcodes: p.barcodes })) }),
      });
      const json = (await res.json()) as { matches?: PageMatch[]; error?: string };
      if (!res.ok || !json.matches) throw new Error(json.error ?? "Couldn't match the labels to orders.");

      const batchId = crypto.randomUUID();
      for (let i = 0; i < pages.length; i++) {
        setProgress(`Saving label ${i + 1} of ${pages.length}…`);
        const p = pages[i];
        const m = json.matches[i];
        const save = await fetch("/api/ship/labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            batchId,
            page: p.page,
            trackingNumber: m?.trackingNumber ?? null,
            carrier: m?.carrier ?? null,
            orderIds: m?.orderIds ?? [],
            buyerUsernames: m?.buyerUsernames ?? [],
            widthIn: p.widthIn,
            heightIn: p.heightIn,
            image: p.png,
          }),
        });
        if (!save.ok) {
          const err = (await save.json().catch(() => ({}))) as { error?: string };
          throw new Error(`Page ${p.page}: ${err.error ?? "couldn't save it."}`);
        }
      }
      const matched = json.matches.filter((m) => m.orderIds.length > 0).length;
      setSummary(
        matched === pages.length
          ? `All ${pages.length} labels matched to their orders. Scan a box's packing slip to print its label.`
          : `${matched} of ${pages.length} labels matched. The other ${pages.length - matched} need their packing slip scanned: tap Assign, then scan the slip.`
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that PDF.");
    } finally {
      setProgress(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeBatch(batchId: string) {
    if (!window.confirm("Remove every label from this upload? Upload the PDF again to bring them back.")) return;
    await fetch(`/api/ship/labels?batch=${encodeURIComponent(batchId)}`, { method: "DELETE" }).catch(() => null);
    onChanged();
  }

  const rows = labels ?? [];
  const unmatched = rows.filter((l) => l.orderIds.length === 0 && l.hasImage);
  const toPrint = rows.filter((l) => l.orderIds.length > 0 && !l.printedAt && l.hasImage);
  const printed = rows.filter((l) => l.printedAt);
  const wrongSize = rows.some((l) => l.notFourBySix && !l.printedAt && l.hasImage);
  // Newest upload first; Remove takes a whole upload out.
  const batches = [...new Set(rows.map((l) => l.batchId))];

  return (
    <Card>
      <SectionHeader
        title="Shipping labels"
        description="After buying every label on eBay, upload the label PDF. Then scan each box's packing slip and its label prints."
        action={
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={progress != null}>
            {progress ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <FileUp className="size-4" aria-hidden />}
            Upload label PDF
          </Button>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      {progress && <p className="mb-2 text-sm font-medium text-primary">{progress}</p>}
      {error && (
        <Alert tone="danger" className="mb-2">
          {error}
        </Alert>
      )}
      {summary && <p className="mb-2 text-sm text-foreground">{summary}</p>}
      {wrongSize && (
        <Alert tone="warning" title="These labels aren't 4x6" className="mb-2">
          They&apos;d print small on the Rollo. In eBay&apos;s label printing settings, choose the 4&quot; x 6&quot; label
          printer format, then download the PDF again and upload it.
        </Alert>
      )}

      {labels && rows.length > 0 && (
        <p className="text-sm text-foreground">
          <span className="font-medium">{toPrint.length} to print</span>
          {" · "}
          {printed.length} printed
          {unmatched.length > 0 && <span className="font-medium text-amber-700"> · {unmatched.length} not matched</span>}
        </p>
      )}

      {unmatched.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {unmatched.map((l) => (
            <li
              key={l.id}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-2",
                assigningId === l.id ? "border-primary bg-primary/5" : "border-amber-200 bg-amber-50"
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/ship/labels/${l.id}/image`} alt="" className="h-24 w-16 shrink-0 rounded border border-border bg-white object-contain" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium text-foreground">Page {l.page}: couldn&apos;t tell which order</p>
                <p className="text-xs text-muted-foreground">
                  {assigningId === l.id
                    ? "Now scan the packing slip on the box this label goes on."
                    : l.trackingNumber
                      ? `Tracking ${l.trackingNumber}`
                      : "No tracking number found on it"}
                </p>
              </div>
              <Button size="sm" variant={assigningId === l.id ? "outline" : "primary"} onClick={() => onAssign(assigningId === l.id ? null : l.id)}>
                {assigningId === l.id ? "Cancel" : "Assign"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground underline"
          >
            {showAll ? "Hide" : "Show"} all labels ({rows.length})
            <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} aria-hidden />
          </button>
          {showAll && (
            <div className="mt-2 flex flex-col gap-3">
              {batches.map((batchId) => {
                const inBatch = rows.filter((l) => l.batchId === batchId);
                return (
                  <div key={batchId} className="rounded-lg border border-border">
                    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
                      <span>
                        Uploaded {new Date(inBatch[0].createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{" "}
                        · {inBatch.length} page{inBatch.length === 1 ? "" : "s"}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => removeBatch(batchId)}>
                        <Trash2 className="size-4" aria-hidden />
                        Remove
                      </Button>
                    </div>
                    <ul className="divide-y divide-border text-sm">
                      {inBatch.map((l) => (
                        <li key={l.id} className="flex items-center gap-2 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-foreground">
                              {l.orderIds.length > 0 ? `Order ${l.orderIds.join(" + ")}` : `Page ${l.page}, not matched`}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {[l.carrier, l.trackingNumber].filter(Boolean).join(" ") || "No tracking number"}
                              {l.printedAt &&
                                ` · printed ${new Date(l.printedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${l.printedBy ? ` by ${l.printedBy}` : ""}`}
                            </p>
                          </div>
                          {l.printedAt ? <Badge tone="success">Done</Badge> : l.orderIds.length > 0 ? <Badge>To print</Badge> : null}
                          {l.printedAt && l.orderIds.length > 0 && l.hasImage && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onReprint(l.orderIds[0])}>
                              <Printer className="size-4" aria-hidden />
                              Reprint
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
