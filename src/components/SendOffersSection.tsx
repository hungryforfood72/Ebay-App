"use client";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Field, Input, Textarea } from "@/components/ui/Input";
import type { EligibleOfferListing } from "@/lib/offers";
import { MAX_OFFER_PERCENT, MIN_OFFER_PERCENT, offerOutcome } from "@/lib/offerMath";
import { MIN_PROFIT_PER_SALE } from "@/lib/packSize";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type OffersData = { listings: EligibleOfferListing[]; eligibleOnAccount: number; targetMarginPct: number };
type SendState = { status: "sending" } | { status: "sent"; buyerCount: number; offerPrice: number } | { status: "error"; message: string };

const DEFAULT_MESSAGE = "Thanks for your interest! Here's a special price just for you. This offer is good for 48 hours.";
const money = (n: number) => `$${n.toFixed(2)}`;

// Owner only (both API routes are too): Seller Hub's "Eligible to send
// offers", limited to listings this app tracks. Render it only for the
// owner, so an employee's browser never even asks.
export function SendOffersSection() {
  const [data, setData] = useState<OffersData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [percent, setPercent] = useState("10");
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [sends, setSends] = useState<Record<string, SendState>>({});
  const [bulkSending, setBulkSending] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/offers")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Couldn't load eligible listings.");
        return body as OffersData;
      })
      .then((body) => {
        setData(body);
        setSends({});
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load eligible listings."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pct = Number(percent);
  const pctValid = percent !== "" && Number.isFinite(pct) && pct >= MIN_OFFER_PERCENT && pct <= MAX_OFFER_PERCENT;
  const listings = data?.listings ?? [];
  const rows = listings.map((l) => {
    const outcome = pctValid ? offerOutcome(l, pct) : null;
    const losesMoney = outcome != null && l.costKnown && outcome.profit < 0;
    return { l, outcome, losesMoney };
  });
  const sendable = rows.filter((r) => !r.losesMoney && sends[r.l.itemId]?.status !== "sent");

  async function send(itemId: string): Promise<boolean> {
    setSends((s) => ({ ...s, [itemId]: { status: "sending" } }));
    try {
      const res = await fetch("/api/offers/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, discountPercent: pct, message: message.trim() || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Sending the offer failed.");
      setSends((s) => ({ ...s, [itemId]: { status: "sent", buyerCount: body.buyerCount, offerPrice: body.offerPrice } }));
      return true;
    } catch (e) {
      setSends((s) => ({ ...s, [itemId]: { status: "error", message: e instanceof Error ? e.message : "Sending failed." } }));
      return false;
    }
  }

  async function sendOne(row: (typeof rows)[number]) {
    if (!row.outcome) return;
    if (!confirm(`Send ${pct}% off "${row.l.title}" (${money(row.outcome.offerPrice)}) to everyone interested in it? The offer lasts 2 days.`)) return;
    await send(row.l.itemId);
  }

  async function sendAll() {
    const skipped = rows.filter((r) => r.losesMoney).length;
    if (
      !confirm(
        `Send ${pct}% off to the interested buyers on ${sendable.length} listing${sendable.length === 1 ? "" : "s"}?` +
          (skipped ? ` ${skipped} that would lose money at ${pct}% will be skipped.` : "") +
          " Offers last 2 days."
      )
    ) {
      return;
    }
    setBulkSending(true);
    // One at a time: eBay takes one listing per request, and it keeps any
    // failure tied to its own row.
    for (const row of sendable) await send(row.l.itemId);
    setBulkSending(false);
  }

  return (
    <section>
      <SectionHeader
        title="Send offers"
        description="App listings with buyers watching or holding them in a cart. Offers go to all of them at once."
        action={
          <div className="flex items-center gap-2">
            {data && <Badge tone={listings.length > 0 ? "primary" : "neutral"}>{listings.length}</Badge>}
            <Button size="sm" variant="ghost" onClick={load} disabled={loading || bulkSending} aria-label="Refresh eligible listings">
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} aria-hidden />
            </Button>
          </div>
        }
      />
      {error ? (
        <Card>
          <p className="text-sm text-danger">{error}</p>
        </Card>
      ) : !data ? (
        <Card>
          <p className="text-sm text-muted-foreground">Checking eBay…</p>
        </Card>
      ) : listings.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            No app listings are eligible right now.
            {data.eligibleOnAccount > 0 &&
              ` eBay shows ${data.eligibleOnAccount} eligible on the account, all of them listed outside the app.`}
          </p>
        </Card>
      ) : (
        <Card className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <Field label="Discount" hint={`${MIN_OFFER_PERCENT}–${MAX_OFFER_PERCENT}% off the listed price`}>
              <div className="relative">
                <Input
                  type="number"
                  min={MIN_OFFER_PERCENT}
                  max={MAX_OFFER_PERCENT}
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  aria-label="Discount percent"
                  className="pr-8"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                  %
                </span>
              </div>
            </Field>
            <Field label="Message to buyers" hint="Optional. eBay says offers with a message convert better.">
              <Textarea rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
            </Field>
          </div>

          <ul className="flex flex-col divide-y divide-border">
            {rows.map(({ l, outcome, losesMoney }) => {
              const state = sends[l.itemId];
              const target = l.unitCost != null ? Math.max(l.unitCost * (data.targetMarginPct / 100), MIN_PROFIT_PER_SALE) : null;
              const tone: BadgeTone = !outcome
                ? "neutral"
                : losesMoney
                  ? "danger"
                  : target != null && outcome.profit < target
                    ? "warning"
                    : l.costKnown
                      ? "success"
                      : "neutral";
              return (
                <li key={l.itemId} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <a
                      href={`https://www.ebay.com/itm/${l.listingId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-start gap-1 font-medium leading-snug text-foreground hover:underline"
                    >
                      {l.title}
                      <ExternalLink className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      {outcome ? (
                        <span>
                          <span className="line-through">{money(l.listPrice)}</span>{" "}
                          <span className="font-medium text-foreground">{money(outcome.offerPrice)}</span>
                        </span>
                      ) : (
                        <span>{money(l.listPrice)}</span>
                      )}
                      {outcome && (
                        <Badge tone={tone}>
                          {losesMoney
                            ? `loses ${money(-outcome.profit)}`
                            : `${money(outcome.profit)} profit`}
                        </Badge>
                      )}
                      {l.costKnown && l.unitCost != null ? (
                        <span>after {money(l.unitCost)} item cost</span>
                      ) : l.noCostReason === "no_manifest" ? (
                        <span>no manifest, item cost not counted</span>
                      ) : (
                        <span>manifest has no cost yet, item cost not counted</span>
                      )}
                      {l.promotedPercent != null && <span>promoted {l.promotedPercent}%</span>}
                      {l.lastOffer && !state && (
                        <span>
                          last sent {l.lastOffer.discountPercent}% off on {new Date(l.lastOffer.sentAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    {state?.status === "error" && <p className="mt-1 text-sm text-danger">{state.message}</p>}
                  </div>
                  <div className="shrink-0">
                    {state?.status === "sent" ? (
                      <Badge tone="success">
                        Sent to {state.buyerCount} buyer{state.buyerCount === 1 ? "" : "s"}
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => sendOne({ l, outcome, losesMoney })}
                        disabled={!pctValid || losesMoney || bulkSending || state?.status === "sending"}
                      >
                        {state?.status === "sending" ? "Sending…" : "Send offer"}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Profit is after eBay fees, any promotion fee, a {money(listings[0].labelCost)} label and the item&apos;s cost.
              Green clears your {data.targetMarginPct}% on cost and {money(MIN_PROFIT_PER_SALE)} a sale.
            </p>
            <Button onClick={sendAll} disabled={!pctValid || sendable.length === 0 || bulkSending}>
              {bulkSending ? "Sending…" : `Send to all ${sendable.length}`}
            </Button>
          </div>
        </Card>
      )}
    </section>
  );
}
