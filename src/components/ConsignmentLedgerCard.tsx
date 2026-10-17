"use client";

import { Stat } from "@/components/Stat";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/Input";
import { ChevronDown, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

// Mirrors ConsignmentLedger in src/lib/consignmentLedger.ts (dates as JSON strings).
type Ledger = {
  supplierPct: number;
  earned: number;
  paid: number;
  balance: number;
  sales: {
    id: string;
    soldAt: string;
    channel: string;
    title: string;
    units: number;
    revenue: number;
    costs: number;
    profit: number;
    supplierShare: number;
    labelPending: boolean;
  }[];
  payments: { id: string; amount: number; paidAt: string; note: string | null; recordedBy: string | null }[];
};

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const money = (n: number) => `$${n.toFixed(2)}`;

async function fetchLedger(manifestId: string): Promise<Ledger> {
  const res = await fetch(`/api/manifests/${manifestId}/consignment`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Couldn't load what's owed.");
  return data as Ledger;
}

// Running balance owed to a consignment supplier, on the manifest page.
export function ConsignmentLedgerCard({ manifestId }: { manifestId: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [showSales, setShowSales] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchLedger(manifestId)
      .then((data) => !cancelled && setLedger(data))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load what's owed."));
    return () => {
      cancelled = true;
    };
  }, [manifestId]);

  async function send(init: RequestInit, query = "") {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/manifests/${manifestId}/consignment${query}`, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't save.");
      setLedger(data as Ledger);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function recordPayment() {
    const ok = await send({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Noon local, so the date doesn't slip a day in either direction.
      body: JSON.stringify({ amount: Number(amount), paidAt: new Date(`${paidOn}T12:00:00`).toISOString(), note }),
    });
    if (ok) {
      setAmount("");
      setNote("");
      setPaidOn(today());
    }
  }

  async function removePayment(paymentId: string) {
    if (!window.confirm("Remove this payment?")) return;
    await send({ method: "DELETE" }, `?payment=${encodeURIComponent(paymentId)}`);
  }

  const pendingLabels = ledger?.sales.filter((s) => s.labelPending).length ?? 0;

  return (
    <section>
      <SectionHeader
        title="Owed to supplier"
        description={
          ledger
            ? `His ${ledger.supplierPct}% of the profit on each sale, after eBay fees and the label. A sale that loses money owes him nothing.`
            : undefined
        }
      />
      {error && <p className="mb-3 text-sm font-medium text-danger">{error}</p>}
      {ledger && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Owed now" value={ledger.balance} format="currency" highlight={ledger.balance > 0} />
            <Stat
              label="His share so far"
              value={ledger.earned}
              format="currency"
              hint={`${ledger.sales.length} sale${ledger.sales.length === 1 ? "" : "s"}`}
            />
            <Stat label="Paid to him" value={ledger.paid} format="currency" hint={`${ledger.payments.length} payment${ledger.payments.length === 1 ? "" : "s"}`} />
          </div>
          {pendingLabels > 0 && (
            <p className="text-xs text-muted-foreground">
              {pendingLabels} eBay sale{pendingLabels === 1 ? " is" : "s are"} still waiting on the label cost, so his share
              there may come down a little once it posts.
            </p>
          )}

          <Card>
            <p className="mb-3 text-sm font-medium text-foreground">Record a payment</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <label htmlFor="pay-amount" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Amount
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">$</span>
                  <Input
                    id="pay-amount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    placeholder={ledger.balance > 0 ? ledger.balance.toFixed(2) : "0.00"}
                    onChange={(e) => setAmount(e.target.value)}
                    className="pl-7"
                  />
                </div>
              </div>
              <div className="w-40">
                <label htmlFor="pay-date" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Paid on
                </label>
                <Input id="pay-date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
              </div>
              <div className="min-w-40 flex-1">
                <label htmlFor="pay-note" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Note (optional)
                </label>
                <Input id="pay-note" value={note} placeholder="Cash, Zelle…" onChange={(e) => setNote(e.target.value)} />
              </div>
              {ledger.balance > 0 && !amount && (
                <Button variant="ghost" size="sm" onClick={() => setAmount(ledger.balance.toFixed(2))}>
                  Pay full balance
                </Button>
              )}
              <Button size="sm" onClick={recordPayment} disabled={saving || !(Number(amount) > 0) || !paidOn}>
                {saving ? "Saving…" : "Record payment"}
              </Button>
            </div>
            {ledger.payments.length > 0 && (
              <ul className="mt-4 divide-y divide-border border-t border-border text-sm">
                {ledger.payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="font-medium tabular-nums text-foreground">{money(p.amount)}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        · {new Date(p.paidAt).toLocaleDateString()}
                        {p.note ? ` · ${p.note}` : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removePayment(p.id)}
                      disabled={saving}
                      aria-label="Remove payment"
                      title="Remove payment"
                      className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-danger"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {ledger.sales.length > 0 && (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setShowSales((v) => !v)} className="-ml-2">
                <ChevronDown className={cn("size-4 transition-transform", showSales && "rotate-180")} aria-hidden />
                {showSales ? "Hide" : "Show"} sales behind this ({ledger.sales.length})
              </Button>
              {showSales && (
                <ul className="mt-2 divide-y divide-border rounded-xl border border-border text-sm">
                  {ledger.sales.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium leading-snug text-foreground">{s.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(s.soldAt).toLocaleDateString()} · {s.channel} · {s.units} unit{s.units === 1 ? "" : "s"} ·
                          sold {money(s.revenue)}, costs {money(s.costs)}
                          {s.labelPending ? " (label not in yet)" : ""}
                        </p>
                      </div>
                      <div className="shrink-0 text-right tabular-nums">
                        <Badge tone={s.supplierShare > 0 ? "primary" : "neutral"}>His share {money(s.supplierShare)}</Badge>
                        <p className="mt-1 text-xs text-muted-foreground">profit {money(s.profit)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
