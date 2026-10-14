"use client";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Input, Textarea } from "@/components/ui/Input";
import type { BuyerOfferRow } from "@/lib/buyerOffers";
import { priceOutcome } from "@/lib/offerMath";
import { FALLBACK_FEE_FIXED, FALLBACK_FEE_RATE, MIN_PROFIT_PER_SALE } from "@/lib/packSize";
import { ExternalLink, MapPin, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type OffersData = { offers: BuyerOfferRow[]; otherListingOffers: number; typicalLabel: number; targetMarginPct: number };
type Action = "Accept" | "Decline" | "Counter";
type RespondState =
  | { status: "sending"; action: Action }
  | { status: "done"; action: Action; counterPrice?: number }
  | { status: "error"; message: string };

const SELLER_RESPONSE_MAX = 250;
const money = (n: number) => `$${n.toFixed(2)}`;

function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
  return hours > 0 ? `${hours}h left` : `${Math.max(1, Math.round(ms / 60_000))}m left`;
}

// What this sale has to clear to be green: the target margin on cost, or
// $1.50 a sale, whichever is higher. Same rule as the send-offers section.
function targetProfit(o: BuyerOfferRow, quantity: number, targetMarginPct: number): number | null {
  return o.unitCost != null ? Math.max(o.unitCost * quantity * (targetMarginPct / 100), MIN_PROFIT_PER_SALE) : null;
}

// Lowest price per unit that still hits the target (or breaks even when
// there's no cost to go on), solving priceOutcome for the price.
function priceForProfit(o: BuyerOfferRow, quantity: number, profit: number): number {
  const rate = FALLBACK_FEE_RATE + (o.promotedPercent ?? 0) / 100;
  const needed = (profit + FALLBACK_FEE_FIXED + o.labelCost + (o.unitCost ?? 0) * quantity) / (quantity * (1 - rate));
  return Math.ceil(needed * 100) / 100;
}

// Owner only (both API routes are too): Best Offers buyers sent on app
// listings, answered here instead of in Seller Hub so the profit is in view.
export function BuyerOffersSection() {
  const [data, setData] = useState<OffersData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/offers/received")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Couldn't load buyer offers.");
        return body as OffersData;
      })
      .then((body) => {
        setData(body);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load buyer offers."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  const offers = data?.offers ?? [];

  return (
    <section>
      <SectionHeader
        title="Buyer offers"
        description="Best Offers buyers sent on app listings. Accept, counter or decline with the profit in view."
        action={
          <div className="flex items-center gap-2">
            {data && <Badge tone={offers.length > 0 ? "warning" : "neutral"}>{offers.length}</Badge>}
            <Button size="sm" variant="ghost" onClick={load} disabled={loading} aria-label="Refresh buyer offers">
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
      ) : (
        <div className="flex flex-col gap-3">
          {offers.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground">No offers waiting on app listings.</p>
            </Card>
          ) : (
            offers.map((o) => <OfferCard key={o.bestOfferId} offer={o} targetMarginPct={data.targetMarginPct} />)
          )}
          {data.otherListingOffers > 0 && (
            <p className="text-xs text-muted-foreground">
              {data.otherListingOffers} more pending on listings made outside the app. Answer those in Seller Hub.
            </p>
          )}
          {offers.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Profit is after eBay fees, any promotion fee, an estimated label and the item&apos;s cost. The label is
              your {money(data.typicalLabel)} average, adjusted for the buyer&apos;s USPS zone and the item&apos;s weight.
              Green clears your {data.targetMarginPct}% on cost and {money(MIN_PROFIT_PER_SALE)} a sale.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function OfferCard({ offer: o, targetMarginPct }: { offer: BuyerOfferRow; targetMarginPct: number }) {
  const target = targetProfit(o, o.quantity, targetMarginPct);
  const goodPrice = Math.min(priceForProfit(o, o.quantity, target ?? 0), Math.round((o.listPrice - 0.01) * 100) / 100);
  const [counter, setCounter] = useState(() => Math.max(goodPrice, o.price + 0.01).toFixed(2));
  const [note, setNote] = useState("");
  const [state, setState] = useState<RespondState | null>(null);

  const atOffer = priceOutcome(o, o.price, o.quantity);
  const counterNum = Number(counter);
  const counterValid = counter !== "" && Number.isFinite(counterNum) && counterNum > o.price && counterNum < o.listPrice;
  const atCounter = counterValid ? priceOutcome(o, counterNum, o.quantity) : null;
  const percentOff = Math.round((1 - o.price / o.listPrice) * 100);

  const toneFor = (profit: number): BadgeTone =>
    profit < 0 ? "danger" : target != null && profit < target ? "warning" : o.costKnown ? "success" : "neutral";
  const profitLabel = (profit: number) => (profit < 0 ? `loses ${money(-profit)}` : `${money(profit)} profit`);

  async function respond(action: Action) {
    const qty = o.quantity > 1 ? ` x${o.quantity}` : "";
    const prompt =
      action === "Accept"
        ? `Accept ${money(o.price)}${qty} from ${o.buyer.userId}? This is a sale.` +
          (atOffer.profit < 0 ? ` It loses ${money(-atOffer.profit)}.` : ` About ${money(atOffer.profit)} profit.`)
        : action === "Counter"
          ? `Counter ${o.buyer.userId} at ${money(counterNum)}${qty}?`
          : `Decline ${o.buyer.userId}'s ${money(o.price)} offer?`;
    if (!confirm(prompt)) return;
    setState({ status: "sending", action });
    try {
      const res = await fetch("/api/offers/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          bestOfferId: o.bestOfferId,
          listingId: o.listingId,
          message: note.trim() || null,
          counterPrice: action === "Counter" ? counterNum : undefined,
          counterQuantity: action === "Counter" ? o.quantity : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "eBay didn't take that response.");
      setState({ status: "done", action, counterPrice: action === "Counter" ? counterNum : undefined });
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : "Something went wrong." });
    }
  }

  const busy = state?.status === "sending";
  const location = [o.buyer.state, o.buyer.zip3 ? `ZIP ${o.buyer.zip3}xx` : null, o.zone ? `zone ${o.zone}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <a
          href={`https://www.ebay.com/itm/${o.listingId}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-start gap-1 font-medium leading-snug text-foreground hover:underline"
        >
          {o.listingTitle}
          <ExternalLink className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </a>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>
            Offer <span className="font-semibold text-foreground">{money(o.price)}</span>
            {o.quantity > 1 && ` x${o.quantity}`} on {money(o.listPrice)} ({percentOff}% off)
          </span>
          {o.kind === "BuyerCounterOffer" && <Badge tone="purple">their counter</Badge>}
          <span>{timeLeft(o.expiresAt)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>
            {o.buyer.userId}
            {o.buyer.feedbackScore != null && ` (${o.buyer.feedbackScore})`}
          </span>
          {location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" aria-hidden />
              {location}
            </span>
          )}
        </div>
        {o.buyerMessage && (
          <p className="mt-1 whitespace-pre-line rounded-lg bg-muted px-3 py-2 text-sm text-foreground">&ldquo;{o.buyerMessage}&rdquo;</p>
        )}
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">At their offer:</span>
          <Badge tone={toneFor(atOffer.profit)}>{profitLabel(atOffer.profit)}</Badge>
        </div>
        <p className="text-muted-foreground">
          {money(atOffer.fees)} fees{o.promotedPercent != null && ` (incl. ${o.promotedPercent}% promoted)`} ·{" "}
          {o.localPickupOnly
            ? "pickup, no label"
            : `~${money(o.labelCost)} label${o.weightLbs != null ? ` (${(o.weightLbs * o.quantity).toFixed(1)} lb` : " (no weight"}${o.zone ? `, zone ${o.zone})` : ", zone unknown)"}`}{" "}
          ·{" "}
          {o.unitCost != null
            ? `${money(o.unitCost * o.quantity)} item cost`
            : o.noCostReason === "no_manifest"
              ? "no manifest, item cost not counted"
              : "manifest has no cost yet, item cost not counted"}
        </p>
        <p className="text-muted-foreground">
          {target != null ? `Hits your target at ${money(goodPrice)}` : `Breaks even at ${money(goodPrice)}`}
          {o.quantity > 1 && " each"}.
        </p>
      </div>

      {state?.status === "done" ? (
        <Badge tone={state.action === "Decline" ? "neutral" : "success"}>
          {state.action === "Accept"
            ? "Accepted. It'll come through as an order."
            : state.action === "Counter"
              ? `Countered at ${money(state.counterPrice!)}`
              : "Declined"}
        </Badge>
      ) : (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <Textarea
            rows={2}
            maxLength={SELLER_RESPONSE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value.replace(/</g, ""))}
            placeholder="Note to the buyer (optional), e.g. why you're countering"
            aria-label="Note to the buyer"
          />
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <div className="relative w-28">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">$</span>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={counter}
                  onChange={(e) => setCounter(e.target.value)}
                  aria-label="Counter price"
                  className="pl-6"
                />
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => respond("Counter")} disabled={busy || !counterValid}>
              {state?.status === "sending" && state.action === "Counter" ? "Countering…" : "Counter"}
            </Button>
            {atCounter && <Badge tone={toneFor(atCounter.profit)}>{profitLabel(atCounter.profit)}</Badge>}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="danger-ghost" onClick={() => respond("Decline")} disabled={busy}>
                {state?.status === "sending" && state.action === "Decline" ? "Declining…" : "Decline"}
              </Button>
              <Button size="sm" variant="success" onClick={() => respond("Accept")} disabled={busy}>
                {state?.status === "sending" && state.action === "Accept" ? "Accepting…" : "Accept"}
              </Button>
            </div>
          </div>
          {counter !== "" && !counterValid && (
            <p className="text-xs text-warning">
              A counter has to be above {money(o.price)} and under {money(o.listPrice)}.
            </p>
          )}
          {state?.status === "error" && <p className="text-sm text-danger">{state.message}</p>}
          <p className="text-xs text-muted-foreground">{note.length}/{SELLER_RESPONSE_MAX}. The buyer sees the note with any response.</p>
        </div>
      )}
    </Card>
  );
}
