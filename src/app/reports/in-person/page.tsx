"use client";

import { Stat } from "@/components/Stat";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { CheckboxRow, Field, Select } from "@/components/ui/Input";
import type { InPersonReport, InPersonRow } from "@/lib/inPersonReport";
import { Check, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

// What was sold in person (walk-up off a manifest, or off the shelf), who
// sold it from which scanner login, and the proof behind any sale that
// went under the ideal price or was called expiring soon (Cristian,
// 2026-10-21). Owner only (/reports in proxy.ts). Loading it also checks
// Shopify for unpaid invoices that have been paid since.

const money = (n: number) => `$${n.toFixed(2)}`;
const WHEN = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function InPersonSalesPage() {
  const [days, setDays] = useState(30);
  const [onlyReview, setOnlyReview] = useState(false);
  const [seller, setSeller] = useState("");
  const [report, setReport] = useState<InPersonReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/reports/in-person-sales?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't load sales.");
      setReport(data as InPersonReport);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load sales.");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function review(row: InPersonRow, reviewed: boolean) {
    const res = await fetch(`/api/reports/in-person-sales/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewed }),
    });
    if (!res.ok) return setError("Couldn't save that.");
    const saved = (await res.json()) as { reviewedAt: string | null; reviewedBy: string | null };
    setReport((r) =>
      r
        ? {
            ...r,
            rows: r.rows.map((x) => (x.id === row.id ? { ...x, ...saved, needsReview: !saved.reviewedAt && x.needsReview } : x)),
            totals: { ...r.totals, needsReview: r.totals.needsReview + (reviewed ? -1 : 1) },
          }
        : r
    );
  }

  const rows = (report?.rows ?? []).filter((r) => (!onlyReview || r.needsReview) && (!seller || (r.soldBy ?? "Unknown") === seller));

  return (
    <AppShell
      title="In-person sales"
      subtitle="Walk-up and shelf sales: who sold what, for how much, and why anything went under the ideal price."
      actions={
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {error && <Alert tone="danger">{error}</Alert>}
        {!report && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Loading…
          </p>
        )}
        {report && report.settled.sold > 0 && (
          <Alert tone="success">
            {report.settled.sold} invoice{report.settled.sold === 1 ? " was" : "s were"} paid since the last check and recorded as sold.
          </Alert>
        )}

        {report && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Sales" value={report.totals.sales} />
              <Stat label="Revenue" value={report.totals.revenue} format="currency" />
              <Stat label="Under ideal by" value={report.totals.underBy} format="currency" highlight={report.totals.underBy > 0} />
              <Stat label="To review" value={report.totals.needsReview} highlight={report.totals.needsReview > 0} />
              <Stat label="Unpaid invoices" value={report.totals.unpaid} highlight={report.totals.unpaid > 0} />
            </div>

            {report.sellers.length > 0 && (
              <section>
                <SectionHeader title="By seller" />
                <Card padded={false}>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="px-4 py-2 font-medium">Seller</th>
                        <th className="px-4 py-2 text-right font-medium">Sales</th>
                        <th className="px-4 py-2 text-right font-medium">Revenue</th>
                        <th className="px-4 py-2 text-right font-medium">Flagged</th>
                        <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Under ideal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {report.sellers.map((s) => (
                        <tr key={s.soldBy}>
                          <td className="px-4 py-2 font-medium text-foreground">{s.soldBy}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{s.sales}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{money(s.revenue)}</td>
                          <td className={cn("px-4 py-2 text-right tabular-nums", s.flagged > 0 && "font-semibold text-amber-700")}>{s.flagged}</td>
                          <td className="hidden px-4 py-2 text-right tabular-nums sm:table-cell">{money(s.underBy)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </section>
            )}

            <section>
              <SectionHeader title="Sales" />
              <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Period">
                  <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    <option value={7}>Last 7 days</option>
                    <option value={30}>Last 30 days</option>
                    <option value={90}>Last 90 days</option>
                    <option value={365}>Last year</option>
                  </Select>
                </Field>
                <Field label="Seller">
                  <Select value={seller} onChange={(e) => setSeller(e.target.value)}>
                    <option value="">Everyone</option>
                    {report.sellers.map((s) => (
                      <option key={s.soldBy} value={s.soldBy}>
                        {s.soldBy}
                      </option>
                    ))}
                  </Select>
                </Field>
                <CheckboxRow className="self-end" label="Only ones to review" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
              </div>
              {rows.length === 0 ? (
                <Card>
                  <p className="text-sm text-muted-foreground">{onlyReview ? "Nothing to review." : "No in-person sales in this period."}</p>
                </Card>
              ) : (
                <ul className="flex flex-col gap-2">
                  {rows.map((r) => (
                    <SaleRow key={r.id} row={r} onReview={review} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}

function SaleRow({ row: r, onReview }: { row: InPersonRow; onReview: (r: InPersonRow, reviewed: boolean) => void }) {
  const under = r.idealPricePerUnit != null && r.pricePerUnit < r.idealPricePerUnit - 0.005;
  const pct = under ? Math.round((1 - r.pricePerUnit / r.idealPricePerUnit!) * 100) : 0;
  const unit = r.packSize ? "pack" : "unit";
  return (
    <li>
      <Card className={cn(r.needsReview && "border-amber-300", r.status === "failed" && "border-red-300")}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium leading-snug text-foreground">{r.description}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {WHEN.format(new Date(r.soldAt))} · {r.soldBy ?? "Unknown"}
              {r.kind ? ` · ${r.kind === "walkup" ? "Walk-up" : "Shelf"}` : ""}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold tabular-nums text-foreground">{money(r.total)}</p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {r.quantity} × {money(r.pricePerUnit)}/{unit}
              {r.idealPricePerUnit != null && ` · ideal ${money(r.idealPricePerUnit)}`}
            </p>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {r.payment === "cash" && <Badge tone="neutral">Cash</Badge>}
          {r.payment === "invoice" && (
            <Badge tone={r.status === "sold" ? "success" : r.status === "awaiting_payment" ? "warning" : "danger"}>
              {r.status === "sold"
                ? `Invoice paid${r.shopifyOrderName ? ` ${r.shopifyOrderName}` : ""}`
                : r.status === "awaiting_payment"
                  ? "Invoice not paid yet"
                  : r.status === "cancelled"
                    ? "Invoice cancelled"
                    : "Invoice problem"}
            </Badge>
          )}
          {r.nearExpiry && <Badge tone="warning">Expiring soon</Badge>}
          {under && <Badge tone={r.belowAsked ? "danger" : "warning"}>{pct}% under ideal</Badge>}
          {r.legacy && <Badge tone="neutral">Before checks</Badge>}
          {r.reviewedAt && (
            <Badge tone="success">
              Reviewed{r.reviewedBy ? ` by ${r.reviewedBy}` : ""}
            </Badge>
          )}
        </div>

        {r.customerEmail && <p className="mt-2 text-xs text-muted-foreground">Invoice to {r.customerEmail}</p>}
        {r.reason && (
          <p className="mt-2 text-sm text-foreground">
            <span className="font-medium">Why lower: </span>
            {r.reason}
          </p>
        )}
        {r.error && <p className="mt-2 text-sm text-danger">{r.error}</p>}
        {r.photoUrls.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {r.photoUrls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="Proof photo" className="size-24 rounded-lg border border-border object-cover" />
              </a>
            ))}
          </div>
        )}
        {!r.legacy && (r.needsReview || r.reviewedAt) && (
          <div className="mt-3">
            {r.reviewedAt ? (
              <Button variant="ghost" size="sm" onClick={() => onReview(r, false)}>
                Undo review
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => onReview(r, true)}>
                <Check className="size-4" aria-hidden />
                Looks fine
              </Button>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}
