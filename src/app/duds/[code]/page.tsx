"use client";

import { StationPicker, useChosenStation } from "@/components/StationPicker";
import { useCurrentUser } from "@/components/UserNav";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import type { DudBoxDetail, DudBoxEntry, DudDecision, DudMoneyHint } from "@/lib/warehouse/dudBoxTypes";
import {
  CircleCheck,
  Gift,
  LoaderCircle,
  Printer,
  ShoppingBag,
  ThumbsDown,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, use as usePromise } from "react";
import { STATUS_TEXT, STATUS_TONE } from "../shared";

// One dud box: what's in it and why each product was called a dud, and a
// decision per product. Shopify ones then get listed from the box at the
// listing station (scan the box's label on the scan page). Anyone signed in
// can decide; the owner also sees the Analyzer's money guess so "not worth
// Shopify" is an informed call. Employees never see money.

const DECISIONS: { key: DudDecision; label: string; icon: LucideIcon; on: string }[] = [
  { key: "shopify", label: "Shopify", icon: ShoppingBag, on: "border-primary bg-primary text-primary-foreground" },
  { key: "not_worth", label: "Not worth Shopify", icon: ThumbsDown, on: "border-zinc-700 bg-zinc-700 text-white" },
  { key: "toss", label: "Toss", icon: Trash2, on: "border-red-600 bg-red-600 text-white" },
  { key: "donate", label: "Donate", icon: Gift, on: "border-green-600 bg-green-600 text-white" },
];

const DECISION_TEXT: Record<DudDecision, string> = {
  shopify: "Shopify",
  not_worth: "Not worth Shopify",
  toss: "Toss",
  donate: "Donate",
};

// One product in the box: every entry with the same UPC (the sorter may
// have logged it more than once), decided together.
type Product = {
  upc: string;
  description: string;
  dudReason: string;
  entryIds: string[];
  units: number;
  listed: number;
  // The shared decision, or null if undecided (or the entries disagree).
  decision: DudDecision | null;
  mixed: boolean;
  decidedBy: string | null;
  money: DudMoneyHint | null | undefined;
};

function groupProducts(entries: DudBoxEntry[]): Product[] {
  const byUpc = new Map<string, DudBoxEntry[]>();
  for (const e of entries) byUpc.set(e.upc, [...(byUpc.get(e.upc) ?? []), e]);
  return [...byUpc.values()].map((list) => {
    const first = list[0];
    const decisions = new Set(list.map((e) => e.decision));
    const decision = decisions.size === 1 ? first.decision : null;
    return {
      upc: first.upc,
      description: first.description,
      dudReason: first.dudReason,
      entryIds: list.map((e) => e.id),
      units: list.reduce((sum, e) => sum + e.quantity, 0),
      listed: list.reduce((sum, e) => sum + e.listedUnits, 0),
      decision,
      mixed: decisions.size > 1,
      decidedBy: decision ? (list.find((e) => e.decidedBy)?.decidedBy ?? null) : null,
      money: first.money,
    };
  });
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function DudBoxPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = usePromise(params);
  const user = useCurrentUser();
  const [data, setData] = useState<DudBoxDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const stations = useChosenStation(true);

  const load = useCallback(
    () =>
      fetch(`/api/dud-boxes/${encodeURIComponent(code)}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error ?? "Couldn't load that dud box.");
          return d as DudBoxDetail;
        })
        .then((d) => {
          setData(d);
          setError(null);
        }),
    [code]
  );

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Couldn't load that dud box."));
  }, [load]);

  async function send(url: string, body: unknown, key: string): Promise<boolean> {
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: url.endsWith("/decide") || url.endsWith("/print") ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "That didn't save. Try again.");
      await load().catch(() => {});
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "That didn't save. Try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function decide(p: Product, decision: DudDecision) {
    if (p.decision === decision) return;
    void send(`/api/dud-boxes/${encodeURIComponent(code)}/decide`, { entryIds: p.entryIds, decision }, p.upc);
  }

  async function print(stationId: string) {
    const ok = await send(`/api/dud-boxes/${encodeURIComponent(code)}/print`, { stationId }, "print");
    if (ok) {
      setPrinting(false);
      setNotice(`Label printing at ${stations.stations?.find((s) => s.id === stationId)?.name ?? "the station"}.`);
    }
  }

  const isOwner = user?.role === "owner";
  const products = data ? groupProducts(data.entries) : [];
  const decided = products.filter((p) => p.decision).length;
  const shopify = products.filter((p) => p.decision === "shopify");
  const shopifyUnits = shopify.reduce((sum, p) => sum + p.units, 0);
  const listedUnits = shopify.reduce((sum, p) => sum + Math.min(p.listed, p.units), 0);
  const status = data?.box.status;

  return (
    <AppShell
      width="medium"
      title={<span className="font-mono">{data?.box.code ?? code.toUpperCase()}</span>}
      subtitle={data ? data.box.manifestTitle : error ? undefined : "Loading…"}
      actions={
        <Link href="/duds" className={buttonClasses({ variant: "outline", size: "sm" })}>
          All dud boxes
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {!data && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Loading…
          </p>
        )}

        {data && status && (
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[status]} size="lg">
                {STATUS_TEXT[status]}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {products.length} {products.length === 1 ? "product" : "products"} ·{" "}
                {products.reduce((sum, p) => sum + p.units, 0)} units
              </span>
            </div>
            {products.length > 0 && (
              <>
                <p className="mt-3 text-lg font-semibold text-foreground">
                  {decided} of {products.length} decided
                  {shopify.length > 0 && `, ${shopify.length} going to Shopify`}
                </p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.round((decided / products.length) * 100)}%` }}
                  />
                </div>
                {shopifyUnits > 0 && (
                  <p className="mt-3 text-sm text-foreground">
                    Shopify: listed <span className="font-semibold tabular-nums">{listedUnits}</span> of{" "}
                    <span className="font-semibold tabular-nums">{shopifyUnits}</span>
                    {listedUnits < shopifyUnits && (
                      <span className="mt-1 block text-muted-foreground">
                        Take this box to the listing station and scan its label to list the Shopify ones.
                      </span>
                    )}
                  </p>
                )}
              </>
            )}
            {status === "open" && (
              <p className="mt-3 text-sm text-muted-foreground">
                A sorter is still filling this box. You can decide what&apos;s in it already.
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {status === "open" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy != null}
                  onClick={() => send(`/api/dud-boxes/${encodeURIComponent(code)}`, { status: "closed" }, "status")}
                >
                  Box is full, close it
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy != null}
                  onClick={() => send(`/api/dud-boxes/${encodeURIComponent(code)}`, { status: "open" }, "status")}
                >
                  Reopen for sorting
                </Button>
              )}
              <Button variant="outline" size="sm" disabled={busy != null} onClick={() => setPrinting((v) => !v)}>
                <Printer className="size-4" aria-hidden />
                Reprint label
              </Button>
            </div>
          </Card>
        )}

        {printing && (
          <StationPicker
            stations={stations.stations}
            selectedId={stations.station?.id ?? null}
            error={stations.error}
            onPick={(s) => {
              stations.choose(s.id);
              void print(s.id);
            }}
            onCancel={() => setPrinting(false)}
            onReload={stations.reload}
          />
        )}

        {status === "done" && (
          <Alert tone="success" title="All handled">
            Every product is decided and the Shopify ones are listed. Toss or donate what&apos;s left, as decided.
          </Alert>
        )}
        {actionError && <Alert tone="danger">{actionError}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        {data && products.length === 0 && (
          <Card>
            <p className="text-sm text-muted-foreground">Nothing in this box yet.</p>
          </Card>
        )}

        {products.map((p) => (
          <ProductCard
            key={p.upc}
            product={p}
            isOwner={isOwner}
            busy={busy === p.upc}
            disabled={busy != null}
            onDecide={(d) => decide(p, d)}
          />
        ))}
      </div>
    </AppShell>
  );
}

function ProductCard({
  product: p,
  isOwner,
  busy,
  disabled,
  onDecide,
}: {
  product: Product;
  isOwner: boolean;
  busy: boolean;
  disabled: boolean;
  onDecide: (d: DudDecision) => void;
}) {
  // Units already listed from the box are real listings now; they can't be
  // tossed, so only Shopify stays available.
  const locked = p.listed > 0;
  return (
    <Card className={cn(p.decision && "border-green-200")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug text-foreground">{p.description}</p>
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            UPC {p.upc} · {p.units} {p.units === 1 ? "unit" : "units"}
          </p>
        </div>
        {busy ? (
          <LoaderCircle className="size-5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          p.decision && <CircleCheck className="size-5 shrink-0 text-success" aria-label="Decided" />
        )}
      </div>
      <p className="mt-2 text-sm text-amber-900">{p.dudReason}</p>
      {isOwner && <MoneyHint money={p.money} />}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {DECISIONS.map((d) => {
          const on = p.decision === d.key;
          const Icon = d.icon;
          return (
            <button
              key={d.key}
              type="button"
              aria-pressed={on}
              disabled={disabled || (locked && d.key !== "shopify")}
              onClick={() => onDecide(d.key)}
              className={cn(
                "flex h-14 items-center justify-center gap-2 rounded-lg border px-2 text-sm font-semibold transition-colors",
                "disabled:pointer-events-none disabled:opacity-50",
                on ? d.on : "border-border bg-surface text-foreground hover:bg-muted active:bg-muted"
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {d.label}
            </button>
          );
        })}
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        {p.mixed && (
          <p className="text-warning">Logged more than once with different decisions. Pick one for all of it.</p>
        )}
        {p.decision === "shopify" && (
          <p className="text-sm font-medium text-foreground">
            Listed {Math.min(p.listed, p.units)} of {p.units}
          </p>
        )}
        {locked && <p>Some are already listed from this box, so it stays Shopify.</p>}
        {p.decision && p.decidedBy && (
          <p>
            {DECISION_TEXT[p.decision]}, decided by {p.decidedBy}
          </p>
        )}
      </div>
    </Card>
  );
}

// Owner only: the Analyzer's guess per unit, eBay vs Shopify/Whatnot.
function MoneyHint({ money: m }: { money: DudMoneyHint | null | undefined }) {
  if (m === undefined) return null;
  if (m === null) return <p className="mt-1 text-xs text-muted-foreground">No Analyzer numbers for this product.</p>;
  if (m.ebayPrice == null)
    return <p className="mt-1 text-xs text-muted-foreground">The Analyzer found no price for it.</p>;
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg bg-muted px-3 py-2 text-xs">
      <div>
        <p className="text-muted-foreground">eBay, about {money(m.ebayPrice)}</p>
        <p className="font-semibold tabular-nums text-foreground">
          {m.ebayNet != null ? money(m.ebayNet) : "?"} each after fees and shipping
        </p>
      </div>
      <div>
        <p className="text-muted-foreground">Shopify / Whatnot</p>
        <p className="font-semibold tabular-nums text-foreground">
          {m.shopNet != null ? money(m.shopNet) : "?"} each after fees
        </p>
      </div>
    </div>
  );
}
