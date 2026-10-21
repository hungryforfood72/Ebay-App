"use client";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { CheckboxRow, Field, Input, Textarea } from "@/components/ui/Input";
import { uploadPhoto } from "@/lib/uploadPhoto";
import { Banknote, Camera, Check, CreditCard, LoaderCircle, Mail, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// The checkout for a walk-up or shelf sale (Cristian, 2026-10-21). The
// price to get is the ideal price. "Expiring soon" drops it to the
// near-expiry price but needs a photo of the date; charging less than
// that needs a photo and a reason. The server checks the same rules
// (src/lib/counterSale.ts), so this page can't be talked around.
// Payment: cash, or a Shopify invoice emailed to the customer (Epic
// Steals, local pickup, no shipping) with a photo of the item: the
// listing's, or for a walk-up one the seller takes. An invoice waits here
// until Shopify says it's paid; only then is it sold.

export type CheckoutTarget = {
  kind: "walkup" | "shelf";
  manifestId: string | null;
  itemId: string | null;
  upc: string;
  binCode?: string | null;
};

type Quote = {
  description: string;
  packSize: number | null;
  ideal: number | null;
  nearExpiry: number | null;
  source: "manifest" | "listed" | null;
  // The listed item's photo, shown on the invoice. null = walk-up off the
  // manifest: the seller takes one before sending an invoice.
  photoUrl: string | null;
};

type Photo = { id: string; previewUrl: string; url?: string; status: "uploading" | "done" | "error" };

type InvoiceStatus = {
  id: string;
  state: "awaiting_payment" | "payment_pending" | "sold" | "cancelled" | "failed";
  customerEmail: string | null;
  shopifyOrderName: string | null;
  error: string | null;
};

const POLL_MS = 4000;
const money = (n: number) => `$${n.toFixed(2)}`;

export function CounterSaleCheckout({
  target,
  onDone,
  onCancel,
}: {
  target: CheckoutTarget;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [nearExpiry, setNearExpiry] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [reason, setReason] = useState("");
  const [payment, setPayment] = useState<"cash" | "invoice">("cash");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<InvoiceStatus | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { kind, manifestId, itemId, upc } = target;
  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ kind, upc, ...(manifestId ? { manifestId } : {}), ...(itemId ? { itemId } : {}) });
    fetch(`/api/counter-sales/quote?${q}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Couldn't get the price.");
        return data as Quote;
      })
      .then((q) => {
        if (cancelled) return;
        setQuote(q);
        setQuoteError(null);
        setNearExpiry(false);
        setPrice(q.ideal != null ? q.ideal.toFixed(2) : "");
      })
      .catch((e) => !cancelled && setQuoteError(e instanceof Error ? e.message : "Couldn't get the price."));
    return () => {
      cancelled = true;
    };
  }, [kind, manifestId, itemId, upc]);

  const unit = quote?.packSize ? "pack" : "unit";
  const allowed = quote ? (nearExpiry ? quote.nearExpiry : quote.ideal) : null;
  const priceNum = Number(price);
  const qtyNum = Number(quantity);
  const below = allowed != null && Number.isFinite(priceNum) && priceNum > 0 && priceNum < allowed - 0.005;
  const needInvoicePhoto = payment === "invoice" && !quote?.photoUrl;
  const needPhoto = nearExpiry || below || needInvoicePhoto;
  const photoUrls = photos.filter((p) => p.status === "done" && p.url).map((p) => p.url!);
  const uploading = photos.some((p) => p.status === "uploading");

  function addPhotos(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      const id = `${Date.now()}-${Math.random()}`;
      setPhotos((prev) => [...prev, { id, previewUrl: URL.createObjectURL(file), status: "uploading" }]);
      uploadPhoto(file)
        .then((url) => setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, status: "done", url } : p))))
        .catch(() => setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, status: "error" } : p))));
    }
  }

  async function submit() {
    setMessage(null);
    if (!Number.isInteger(qtyNum) || qtyNum < 1) return setMessage("Enter how many, at least 1.");
    if (!(priceNum > 0)) return setMessage("Enter the price.");
    if (uploading) return setMessage("Wait for the photo to finish uploading.");
    if (nearExpiry && photoUrls.length === 0) return setMessage("Take a photo of the expiration date first.");
    if (below && photoUrls.length === 0) return setMessage("It's under the price: take a photo of the item.");
    if (below && reason.trim().length < 3) return setMessage("It's under the price: say why.");
    if (payment === "invoice" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return setMessage("Enter the customer's email for the invoice.");
    }
    if (needInvoicePhoto && photoUrls.length === 0) return setMessage("Take a photo of the item for the invoice.");
    setSaving(true);
    try {
      const res = await fetch("/api/counter-sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          quantity: qtyNum,
          pricePerUnit: priceNum,
          nearExpiry,
          photoUrls,
          reason: reason.trim() || null,
          payment,
          email: payment === "invoice" ? email.trim() : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed.");
      if (payment === "cash") {
        onDone(`Sold for ${money(priceNum * qtyNum)} cash. Ready for the next one.`);
      } else {
        setInvoice({ id: data.id, state: "awaiting_payment", customerEmail: data.customerEmail, shopifyOrderName: null, error: null });
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  if (invoice) {
    return <InvoiceWait invoice={invoice} setInvoice={setInvoice} total={priceNum * qtyNum} onDone={onDone} />;
  }

  if (quoteError) {
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="danger">{quoteError}</Alert>
        <Button variant="ghost" block onClick={onCancel}>
          Scan a different item instead
        </Button>
      </div>
    );
  }
  if (!quote) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Getting the price…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="text-center">
        <p className="text-sm font-medium text-muted-foreground">{nearExpiry ? "Expiring-soon price" : "Price to charge"}</p>
        <p className="text-4xl font-bold tabular-nums text-foreground">{allowed != null ? money(allowed) : "—"}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {quote.packSize ? `Per pack of ${quote.packSize}. ` : ""}
          {allowed == null
            ? "No price on record for this one. Enter what you charged."
            : quote.source === "listed"
              ? "From its listed price."
              : "Per unit."}
        </p>
      </Card>

      {quote.nearExpiry != null && (
        <CheckboxRow
          label="Expiring soon (within 6 months)"
          description={`Drops the price to ${money(quote.nearExpiry)}. You'll need a photo of the date.`}
          checked={nearExpiry}
          onChange={(e) => {
            const checked = e.target.checked;
            setNearExpiry(checked);
            const next = checked ? quote.nearExpiry : quote.ideal;
            if (next != null) setPrice(next.toFixed(2));
          }}
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label={quote.packSize ? "Packs sold" : "Quantity sold"}>
          <Input
            size="lg"
            type="number"
            min={1}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            onWheel={(e) => e.currentTarget.blur()}
          />
        </Field>
        <Field label={`Price per ${unit}`}>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-lg text-muted-foreground">$</span>
            <Input
              size="lg"
              type="number"
              step="0.01"
              min={0}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onWheel={(e) => e.currentTarget.blur()}
              className={cn("pl-7", below && "border-amber-500")}
            />
          </div>
        </Field>
      </div>
      {priceNum > 0 && qtyNum > 0 && (
        <p className="-mt-2 text-sm text-muted-foreground">
          Total <span className="font-semibold text-foreground">{money(priceNum * qtyNum)}</span>
        </p>
      )}

      {below && (
        <Alert tone="warning">
          That&apos;s under {money(allowed!)}. Take a photo of the item and say why it&apos;s lower. Cristian reviews these.
        </Alert>
      )}

      {needPhoto && (
        <Card className="flex flex-col gap-3">
          <p className="text-sm font-medium text-foreground">
            {nearExpiry && below
              ? "Photos: the expiration date, and the item"
              : nearExpiry
                ? "Photo of the expiration date"
                : "Photo of the item"}
          </p>
          {needInvoicePhoto && (
            <p className="-mt-2 text-xs text-muted-foreground">
              {nearExpiry ? "Take the item photo first: the first photo goes on the invoice." : "This goes on the invoice so they see what they're paying for."}
            </p>
          )}
          {photos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {photos.map((p) => (
                <div key={p.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.previewUrl}
                    alt=""
                    className={cn("size-20 rounded-lg border object-cover", p.status === "error" ? "border-red-400 opacity-50" : "border-border")}
                  />
                  {p.status === "uploading" && (
                    <LoaderCircle className="absolute inset-0 m-auto size-6 animate-spin text-white drop-shadow" aria-hidden />
                  )}
                  <button
                    type="button"
                    aria-label="Remove photo"
                    onClick={() => setPhotos((prev) => prev.filter((x) => x.id !== p.id))}
                    className="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full bg-zinc-800 text-white"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}
          {photos.some((p) => p.status === "error") && <p className="text-xs text-danger">A photo didn&apos;t upload. Remove it and take it again.</p>}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              addPhotos(e.target.files);
              e.target.value = "";
            }}
          />
          <Button variant="outline" size="lg" block onClick={() => fileRef.current?.click()}>
            <Camera className="size-5" aria-hidden />
            Take photo
          </Button>
        </Card>
      )}

      {below && (
        <Field label="Why is it lower?">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Box damaged, missing a piece, bought 3…" />
        </Field>
      )}

      <div>
        <p className="mb-1.5 text-sm font-medium text-foreground">How are they paying?</p>
        <div className="grid grid-cols-2 gap-2">
          <PayOption active={payment === "cash"} onClick={() => setPayment("cash")} icon={<Banknote className="size-5" aria-hidden />}>
            Cash
          </PayOption>
          <PayOption active={payment === "invoice"} onClick={() => setPayment("invoice")} icon={<CreditCard className="size-5" aria-hidden />}>
            Card (invoice)
          </PayOption>
        </div>
        {payment === "invoice" && (
          <Field label="Customer's email" hint="They get an Epic Steals invoice to pay by card, Apple Pay and more. Local pickup, no shipping." className="mt-3">
            <Input size="lg" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </Field>
        )}
        {payment === "invoice" && quote.photoUrl && (
          <div className="mt-3 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={quote.photoUrl} alt="" className="size-14 rounded-lg border border-border object-cover" />
            <p className="text-xs text-muted-foreground">The invoice shows the listing photo.</p>
          </div>
        )}
      </div>

      {message && <Alert tone="danger">{message}</Alert>}

      <Button variant="success" size="xl" block onClick={submit} disabled={saving || uploading}>
        {payment === "cash" ? <Check className="size-5" aria-hidden /> : <Mail className="size-5" aria-hidden />}
        {saving ? "Saving…" : payment === "cash" ? "Got the cash, mark as sold" : "Send the invoice"}
      </Button>
      <Button variant="ghost" block onClick={onCancel}>
        Scan a different item instead
      </Button>
    </div>
  );
}

function PayOption({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-14 items-center justify-center gap-2 rounded-lg border text-base font-medium shadow-sm transition-colors",
        active ? "border-primary bg-blue-50 text-primary ring-2 ring-primary/25" : "border-border bg-surface text-foreground hover:bg-muted"
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// After "Send the invoice": waits for Shopify to say it's paid. The sale
// is only recorded then, so the item stays theirs to hand over only once
// this turns green.
function InvoiceWait({
  invoice,
  setInvoice,
  total,
  onDone,
}: {
  invoice: InvoiceStatus;
  setInvoice: (s: InvoiceStatus) => void;
  total: number;
  onDone: (message: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try {
      const res = await fetch(`/api/counter-sales/${invoice.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't check the payment.");
      setInvoice(data as InvoiceStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check the payment.");
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }, [invoice.id, setInvoice]);

  const waiting = invoice.state === "awaiting_payment" || invoice.state === "payment_pending";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (!document.hidden) void check();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, check]);

  async function cancel() {
    if (!confirm("Cancel this invoice? Nothing gets sold and the item stays.")) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/counter-sales/${invoice.id}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't cancel it.");
      onDone("Invoice cancelled. Nothing was sold.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't cancel it.");
      void check();
    } finally {
      setCancelling(false);
    }
  }

  if (invoice.state === "sold") {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-2xl bg-success p-5 text-white">
          <p className="text-2xl font-bold">Paid. Hand it over.</p>
          <p className="mt-1">
            {money(total)} by invoice{invoice.shopifyOrderName ? ` (order ${invoice.shopifyOrderName})` : ""}.
          </p>
        </div>
        <Button variant="success" size="xl" block onClick={() => onDone(`Sold for ${money(total)} by invoice. Ready for the next one.`)}>
          Next sale
        </Button>
      </div>
    );
  }
  if (invoice.state === "failed" || invoice.state === "cancelled") {
    return (
      <div className="flex flex-col gap-3">
        <Alert tone={invoice.state === "failed" ? "danger" : "warning"}>
          {invoice.state === "failed"
            ? invoice.error ?? "Something went wrong with this invoice. Tell Cristian."
            : "This invoice was cancelled."}
        </Alert>
        <Button variant="outline" block onClick={() => onDone(invoice.state === "failed" ? "Invoice problem logged for Cristian." : "Invoice cancelled.")}>
          Back to scanning
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl bg-primary p-5 text-white">
        <p className="flex items-center gap-2 text-2xl font-bold">
          <LoaderCircle className="size-6 animate-spin" aria-hidden />
          Waiting for payment
        </p>
        <p className="mt-2">
          Invoice for {money(total)} sent to {invoice.customerEmail ?? "the customer"}. They open the email and pay.
        </p>
        <p className="mt-2 font-semibold">Don&apos;t hand it over until this says Paid.</p>
        {invoice.state === "payment_pending" && <p className="mt-1 text-sm opacity-90">Shopify has the order; the payment is still going through.</p>}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button variant="outline" size="lg" block onClick={() => void check()} disabled={checking}>
        <RefreshCw className={cn("size-5", checking && "animate-spin")} aria-hidden />
        Check now
      </Button>
      <Button variant="danger-ghost" block onClick={cancel} disabled={cancelling}>
        {cancelling ? "Cancelling…" : "They're not paying, cancel the invoice"}
      </Button>
    </div>
  );
}
