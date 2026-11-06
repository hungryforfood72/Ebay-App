"use client";

import { Alert } from "@/components/ui/Alert";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import type { CancelledToRelist } from "@/lib/warehouse/cancelledOrders";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// Cancelled orders whose listing had already ended (cancelledOrders.ts).
// The Returns page lists them with a Relist button; the dashboard just
// says how many are waiting.

function useCancelled(refreshKey = 0) {
  const [rows, setRows] = useState<CancelledToRelist[] | null>(null);
  const load = useCallback(() => {
    fetch("/api/returns/cancelled")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: CancelledToRelist[]) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]));
  }, []);
  useEffect(() => load(), [load, refreshKey]);
  return { rows, reload: load };
}

function orderText(r: CancelledToRelist): string {
  const where = r.channel === "ebay" ? "eBay order" : "Shopify order";
  return r.orderId ? `${where} ${r.orderId}` : where;
}

export function CancelledToRelistPanel({ stationId, onRelisted }: { stationId: string | null; onRelisted?: () => void }) {
  const { rows, reload } = useCancelled();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  if (!rows || rows.length === 0) return message ? <Alert tone={message.tone}>{message.text}</Alert> : null;

  async function relist(r: CancelledToRelist) {
    if (!stationId) {
      setMessage({ tone: "danger", text: "Scan a station's QR code first, so the new labels print there." });
      return;
    }
    setBusyId(r.id);
    setMessage(null);
    try {
      const res = await fetch("/api/returns/cancelled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, stationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't relist it. Try again.");
      setMessage({
        tone: "success",
        text: `New listing ${data.newItem.sku}: ${data.labelsQueued || r.units} label(s) printing. Put the new label on it, bin it, and it goes to Review.`,
      });
      reload();
      onRelisted?.();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Couldn't relist it. Try again." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <SectionHeader
        title={`Cancelled orders to relist (${rows.length})`}
        description="These sold their last unit, so the listing ended, then the order was cancelled. Relist makes a new listing."
      />
      {message && (
        <Alert tone={message.tone} className="mb-2">
          {message.text}
        </Alert>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.id}>
            <Card className="flex items-center gap-3">
              {r.photoUrl && <img src={r.photoUrl} alt="" className="size-12 shrink-0 rounded-lg object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{r.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {orderText(r)} · {r.units} unit{r.units === 1 ? "" : "s"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.pickedUnits >= r.units
                    ? "Already picked: get it from the packed order."
                    : r.pickedUnits > 0
                      ? `${r.pickedUnits} in the packed order, ${r.units - r.pickedUnits} still ${r.where ? `at ${r.where}` : "on the shelf"}.`
                      : r.where
                        ? `Still at ${r.where}.`
                        : "Find it where the order was waiting."}
                </p>
              </div>
              <Button size="sm" onClick={() => relist(r)} disabled={busyId !== null}>
                {busyId === r.id ? "Relisting…" : "Relist"}
              </Button>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CancelledToRelistAlert() {
  const { rows } = useCancelled();
  if (!rows || rows.length === 0) return null;
  return (
    <Alert tone="warning" title={`Cancelled orders to relist (${rows.length})`}>
      <p>
        {rows.length === 1 ? "An order was" : "Orders were"} cancelled after the listing had already ended, so{" "}
        {rows.length === 1 ? "that unit has" : "those units have"} nowhere to sell. Relist{" "}
        {rows.length === 1 ? "it" : "them"} from the Returns page.
      </p>
      <Link href="/returns" className={buttonClasses({ size: "sm", className: "mt-3 w-fit" })}>
        Open Returns
      </Link>
    </Alert>
  );
}
