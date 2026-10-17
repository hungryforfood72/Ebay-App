"use client";

import { Stat } from "@/components/Stat";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { ChevronDown, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

// Mirrors SupplierReport in src/lib/supplierShare.ts (dates as JSON strings).
type Status = "picked_up" | "being_listed" | "listed" | "sold_out" | "removed";
type Report = {
  title: string;
  supplierPct: number;
  products: {
    key: string;
    description: string;
    itemNumbers: string[];
    takenUnits: number | null;
    listedUnits: number;
    soldUnits: number;
    status: Status;
    ebayUrl: string | null;
    profit: number;
    hisShare: number;
  }[];
  totals: {
    takenUnits: number;
    listedUnits: number;
    soldUnits: number;
    sales: number;
    costs: number;
    profit: number;
    hisShare: number;
    paid: number;
    owed: number;
  };
  sales: { id: string; soldAt: string; product: string; channel: string; units: number; revenue: number; costs: number; profit: number; hisShare: number }[];
  payments: { id: string; amount: number; paidAt: string; note: string | null }[];
  updatedAt: string;
};

const STATUS: Record<Status, { label: string; tone: BadgeTone }> = {
  picked_up: { label: "Picked up", tone: "neutral" },
  being_listed: { label: "Being listed", tone: "purple" },
  listed: { label: "Listed", tone: "primary" },
  sold_out: { label: "Sold out", tone: "success" },
  removed: { label: "Removed", tone: "warning" },
};

const REFRESH_MS = 60_000;
const money = (n: number) => `$${n.toFixed(2)}`;

async function fetchReport(token: string): Promise<Report> {
  const res = await fetch(`/api/share/${encodeURIComponent(token)}`, { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Couldn't load this report.");
  return data as Report;
}

// What the supplier sees: only the stock that was taken, how it's selling,
// his share, what's been paid and what's still owed. Refreshes itself.
export function SupplierReportView({ token }: { token: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSales, setShowSales] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchReport(token)
        .then((r) => {
          if (cancelled) return;
          setReport(r);
          setError(null);
        })
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load this report."));
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  if (error && !report) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="text-lg font-semibold text-foreground">This link isn&apos;t active</p>
        <p className="mt-2 text-sm text-muted-foreground">Ask for a new one if you need to see the report.</p>
      </main>
    );
  }
  if (!report) {
    return (
      <main className="flex min-h-[50vh] items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading…
      </main>
    );
  }

  const t = report.totals;
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:py-10">
      <header>
        <p className="text-sm font-medium text-muted-foreground">Consignment report</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{report.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Live. Updated {new Date(report.updatedAt).toLocaleString()}. Your share is {report.supplierPct}% of the profit on
          each sale, after eBay fees and the shipping label.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Still owed to you" value={t.owed} format="currency" />
        <Stat label="Your share so far" value={t.hisShare} format="currency" />
        <Stat label="Paid to you" value={t.paid} format="currency" hint={`${report.payments.length} payment${report.payments.length === 1 ? "" : "s"}`} />
        <Stat label="Units sold" value={t.soldUnits} hint={`of ${t.takenUnits} taken`} />
        <Stat label="Listed for sale now" value={t.listedUnits} hint="units" />
        <Stat label="Total profit" value={t.profit} format="currency" hint={`${money(t.sales)} sales − ${money(t.costs)} fees & labels`} />
      </section>

      <Card padded={false}>
        <div className="p-4 pb-0 sm:p-5 sm:pb-0">
          <SectionHeader title="Products taken" description={`${report.products.length} products`} />
        </div>
        {report.products.length === 0 ? (
          <p className="px-4 pb-5 text-sm text-muted-foreground sm:px-5">Nothing has been taken yet.</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {report.products.map((p) => (
              <li key={p.key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="font-medium leading-snug text-foreground">{p.description}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {p.itemNumbers.length ? `Item # ${p.itemNumbers.join(" / ")} · ` : ""}
                    {p.takenUnits != null ? `${p.takenUnits} taken` : "Not counted in yet"}
                    {` · ${p.soldUnits} sold`}
                    {p.listedUnits > 0 ? ` · ${p.listedUnits} listed` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="flex items-center gap-2">
                    {p.ebayUrl && (
                      <a
                        href={p.ebayUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        View on eBay <ExternalLink className="size-3" aria-hidden />
                      </a>
                    )}
                    <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                  </div>
                  {p.hisShare > 0 && <p className="text-xs tabular-nums text-muted-foreground">Your share {money(p.hisShare)}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SectionHeader title="Payments to you" />
        {report.payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {report.payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <span className="text-muted-foreground">
                  {new Date(p.paidAt).toLocaleDateString()}
                  {p.note ? ` · ${p.note}` : ""}
                </span>
                <span className="font-medium tabular-nums text-foreground">{money(p.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {report.sales.length > 0 && (
        <Card padded={false}>
          <button
            type="button"
            onClick={() => setShowSales((v) => !v)}
            className="flex w-full items-center justify-between gap-2 p-4 text-left sm:p-5"
          >
            <span className="font-semibold text-foreground">Every sale ({report.sales.length})</span>
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", showSales && "rotate-180")} aria-hidden />
          </button>
          {showSales && (
            <ul className="divide-y divide-border border-t border-border text-sm">
              {report.sales.map((s) => (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="leading-snug text-foreground">{s.product}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(s.soldAt).toLocaleDateString()} · {s.channel} · sold for {money(s.revenue)}, fees & label{" "}
                      {money(s.costs)}, profit {money(s.profit)}
                    </p>
                  </div>
                  <span className="shrink-0 font-medium tabular-nums text-foreground">{money(s.hisShare)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </main>
  );
}
