"use client";

import { Alert } from "@/components/ui/Alert";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import type { CancelledToRelist } from "@/lib/warehouse/cancelledOrders";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// Cancelled orders whose listing had already ended (cancelledOrders.ts).
// The Returns page lists them with a Relist button, only at the station
// with the item labels (the Listing Station, Cristian 2026-11-06); anywhere
// else it says to go there and sign in. The dashboard says how many wait.

type CancelledResponse = {
  rows: CancelledToRelist[];
  atStation: boolean;
  stationName: string | null;
  goTo?: string;
};

function useCancelled() {
  const [data, setData] = useState<CancelledResponse | null>(null);
  const load = useCallback(() => {
    fetch("/api/returns/cancelled")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: CancelledResponse | null) =>
        setData(d && Array.isArray(d.rows) ? d : { rows: [], atStation: false, stationName: null })
      )
      .catch(() => setData({ rows: [], atStation: false, stationName: null }));
  }, []);
  useEffect(() => load(), [load]);
  return { data, reload: load };
}

function orderText(r: CancelledToRelist): string {
  const where = r.channel === "ebay" ? "eBay order" : "Shopify order";
  return r.orderId ? `${where} ${r.orderId}` : where;
}

// stationId is accepted for the Returns page's call but not used: the
// server prints at the relist station this sign-in is on, never one the
// page names.
export function CancelledToRelistPanel({ onRelisted }: { stationId?: string | null; onRelisted?: () => void }) {
  const { data, reload } = useCancelled();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const rows = data?.rows ?? [];
  if (rows.length === 0) return message ? <Alert tone={message.tone}>{message.text}</Alert> : null;
  const atStation = data?.atStation ?? false;

  async function relist(r: CancelledToRelist) {
    setBusyId(r.id);
    setMessage(null);
    try {
      const res = await fetch("/api/returns/cancelled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Couldn't relist it. Try again.");
      setMessage({
        tone: "success",
        text: `New listing ${body.newItem.sku}: ${body.labelsQueued || r.units} label(s) printing. Put the new label over the old one, bin it, and it goes to Review.`,
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
      {!atStation && (
        <Alert tone="warning" className="mb-2">
          {data?.goTo ?? "Relisting is done at the Listing Station. Go there and sign in."}
        </Alert>
      )}
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
              {atStation && (
                <Button size="sm" onClick={() => relist(r)} disabled={busyId !== null}>
                  {busyId === r.id ? "Relisting…" : "Relist"}
                </Button>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CancelledToRelistAlert() {
  const { data } = useCancelled();
  const rows = data?.rows ?? [];
  if (rows.length === 0) return null;
  const where = data?.stationName ? `at the ${data.stationName}` : "at the listing station";
  return (
    <Alert tone="warning" title={`Cancelled orders to relist (${rows.length})`}>
      <p>
        {rows.length === 1 ? "An order was" : "Orders were"} cancelled after the listing had already ended, so{" "}
        {rows.length === 1 ? "that unit has" : "those units have"} nowhere to sell. Relist{" "}
        {rows.length === 1 ? "it" : "them"} from the Returns page {where}, where the item labels are.
      </p>
      <Link href="/returns" className={buttonClasses({ size: "sm", className: "mt-3 w-fit" })}>
        Open Returns
      </Link>
    </Alert>
  );
}
