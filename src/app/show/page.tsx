"use client";

import { beep, focusField } from "@/app/bins/ui";
import { ScanField } from "@/components/ScanField";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import type { ShowFeed, SortScanResult } from "@/lib/whatnotShow";
import { Gift, LoaderCircle, Package } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// The Whatnot show screen (Cristian, 2026-11-07). The host scans an item's
// label into Whatnot's search and runs it; once it sells, the runner scans
// the same label here and the screen says which buyer's show box it goes
// in (a buyer's first buy gets the lowest free box). Solo mode (owner
// switch): nobody scans, the screen shows each sale's box as it comes in.
// After the show, Packing (/show/pack) checks each box and prints labels.

type ShowOption = { id: string; title: string; status: string; startsAt: string | null };
const SHOW_KEY = "ebay-tool.showId";
const FEED_MS = 3_000;
const RETRY_MS = 2_000;
// How long a scan waits for its sale before giving up (the auction's last
// seconds plus Whatnot's order).
const WAIT_LIMIT_MS = 90_000;

function loadShowId(): string {
  try {
    return localStorage.getItem(SHOW_KEY) ?? "";
  } catch {
    return "";
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? "Something went wrong. Try again.");
  return data as T;
}

type Waiting = { code: string; title: string; since: number; sortedBox: number | null };

export default function ShowPage() {
  const [shows, setShows] = useState<ShowOption[] | null>(null);
  const [connected, setConnected] = useState(true);
  const [showId, setShowIdState] = useState(() => (typeof window === "undefined" ? "" : loadShowId()));
  const [feed, setFeed] = useState<(ShowFeed & { owner: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState("");
  const [result, setResult] = useState<Extract<SortScanResult, { status: "sorted" }> | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [busy, setBusy] = useState(false);
  const lastSaleRef = useRef<string | null>(null);

  useEffect(() => {
    fetch("/api/show", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { shows?: ShowOption[]; connected?: boolean; error?: string }) => {
        if (d.error) setError(d.error);
        setConnected(d.connected !== false);
        setShows(d.shows ?? []);
        // One live show and none picked: that's the one.
        const live = (d.shows ?? []).filter((s) => s.status === "live");
        if (!loadShowId() && live.length === 1) setShowId(live[0].id);
      })
      .catch(() => setShows([]));
  }, []);

  function setShowId(id: string) {
    setShowIdState(id);
    setFeed(null);
    setResult(null);
    setWaiting(null);
    lastSaleRef.current = null;
    try {
      if (id) localStorage.setItem(SHOW_KEY, id);
      else localStorage.removeItem(SHOW_KEY);
    } catch {
      // Not remembered on this device: fine for this visit.
    }
  }

  const loadFeed = useCallback(async () => {
    if (!showId) return;
    const r = await fetch(`/api/show?showId=${encodeURIComponent(showId)}`, { cache: "no-store" });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error ?? "Couldn't load the show.");
    setFeed(d);
    return d as ShowFeed;
  }, [showId]);

  // The feed, every few seconds while the screen is up.
  useEffect(() => {
    if (!showId) return;
    let stopped = false;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      loadFeed()
        .then((d) => {
          if (stopped || !d) return;
          setError(null);
          // Solo mode: a new sale beeps.
          const newest = d.recent[0]?.id ?? null;
          if (d.solo && newest && lastSaleRef.current && newest !== lastSaleRef.current) beep("next");
          lastSaleRef.current = newest;
        })
        .catch((e) => !stopped && setError((e as Error).message));
    };
    tick();
    const timer = setInterval(tick, FEED_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [showId, loadFeed]);

  const sendScan = useCallback(
    async (code: string, retry: boolean) => {
      const r = await call<SortScanResult>({ action: "scan", showId, code, refresh: true });
      if (r.status === "sorted") {
        setWaiting(null);
        setResult(r);
        beep("ok");
        void loadFeed().catch(() => {});
        return;
      }
      if (r.status === "waiting") {
        setResult(null);
        setWaiting((w) => ({ code: r.code, title: r.title, sortedBox: r.sortedBox, since: retry && w ? w.since : Date.now() }));
        if (!retry) beep("next");
        return;
      }
      setWaiting(null);
      setError(r.message);
      beep("error");
    },
    [showId, loadFeed]
  );

  // Waiting for a sale: ask again every couple of seconds.
  useEffect(() => {
    if (!waiting) return;
    if (Date.now() - waiting.since > WAIT_LIMIT_MS) return;
    const timer = setTimeout(() => {
      sendScan(waiting.code, true).catch((e) => setError((e as Error).message));
    }, RETRY_MS);
    return () => clearTimeout(timer);
  }, [waiting, sendScan]);

  async function onScan() {
    const code = scan.trim();
    setScan("");
    if (!code || !showId) return;
    setBusy(true);
    setError(null);
    try {
      await sendScan(code, false);
    } catch (e) {
      setError((e as Error).message);
      beep("error");
    } finally {
      setBusy(false);
      focusField("show-scan");
    }
  }

  async function boxFull(buyerId: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ box: number }>({ action: "box_full", buyerId });
      setResult((prev) => (prev && prev.buyerId === buyerId ? { ...prev, box: r.box, boxes: [...prev.boxes, r.box], firstForBuyer: true } : prev));
      beep("ok");
      await loadFeed();
    } catch (e) {
      setError((e as Error).message);
      beep("error");
    } finally {
      setBusy(false);
    }
  }

  async function byHand(saleId: string) {
    setBusy(true);
    try {
      await call({ action: "by_hand", saleId });
      await loadFeed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setSolo(on: boolean) {
    if (on && !confirm("Solo mode: nobody scans. Each sold item comes off its bin's count the moment it sells, and this screen shows its box. Turn it on?")) return;
    setBusy(true);
    try {
      await call({ action: "solo", on });
      await loadFeed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const show = shows?.find((s) => s.id === showId);
  const solo = feed?.solo ?? false;
  const latest = feed?.recent[0] ?? null;
  const buyerOf = (id: string) => feed?.buyers.find((b) => b.id === id);
  const waitedOut = waiting != null && Date.now() - waiting.since > WAIT_LIMIT_MS;

  return (
    <AppShell
      width="narrow"
      title="Whatnot show"
      subtitle={show ? show.title : "Sort each sale into its buyer's show box"}
      actions={
        <Link href="/show/pack" className={buttonClasses({ variant: "outline", size: "sm" })}>
          <Package className="size-4" aria-hidden />
          Packing
        </Link>
      }
    >
      <div className="flex flex-col gap-3">
        {!connected && <Alert tone="warning">Whatnot isn&apos;t connected, so the app can&apos;t see the show&apos;s sales.</Alert>}
        <Select value={showId} onChange={(e) => setShowId(e.target.value)} aria-label="Show">
          <option value="">Pick the show…</option>
          {showId && !shows?.some((s) => s.id === showId) && <option value={showId}>The show picked before</option>}
          {(shows ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.status === "live" ? "LIVE · " : ""}
              {s.title}
            </option>
          ))}
        </Select>

        {feed && feed.boxCount === 0 && (
          <Alert tone="warning" title="No show boxes yet">
            {feed.owner ? (
              <>
                Make them and print their labels on the <Link href="/whatnot" className="underline">Whatnot page</Link>.
              </>
            ) : (
              "Ask Cristian to make show boxes on the Whatnot page."
            )}
          </Alert>
        )}
        {feed && feed.boxCount > 0 && feed.freeBoxes <= 3 && (
          <Alert tone="warning">
            Only {feed.freeBoxes} free show box{feed.freeBoxes === 1 ? "" : "es"} left.
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}

        {showId && !solo && (
          <Card>
            <ScanField
              id="show-scan"
              label="Scan the sold item"
              prompt="Scan the ES label after it sells"
              autoFocus
              value={scan}
              onChange={setScan}
              onScan={onScan}
              hint={busy ? "Checking…" : "Scan it once it sells. The box shows here."}
            />
          </Card>
        )}

        {/* The answer, big enough to read from across the table. */}
        {!solo && result && (
          <Card className="text-center">
            {result.firstForBuyer && <Badge tone="success">New box</Badge>}
            {result.giveaway && (
              <Badge tone="purple" className="ml-1">
                <Gift className="mr-1 size-3.5" aria-hidden />
                Giveaway
              </Badge>
            )}
            <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Show box</p>
            <p className="text-8xl font-black leading-none tabular-nums">{result.box ?? "?"}</p>
            {result.box == null && <p className="mt-2 font-medium text-danger">No free show box. Make more on the Whatnot page.</p>}
            <p className="mt-2 text-lg font-semibold">{result.buyer}</p>
            {result.boxes.length > 1 && <p className="text-sm text-muted-foreground">Their boxes: {result.boxes.join(", ")}</p>}
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              <span className="font-mono">{result.code}</span> {result.title}
            </p>
            <Button className="mt-3" variant="outline" size="sm" disabled={busy} onClick={() => boxFull(result.buyerId)}>
              Box full? Give them another
            </Button>
          </Card>
        )}

        {!solo && waiting && (
          <Card className="text-center">
            {!waitedOut ? (
              <p className="flex items-center justify-center gap-2 text-lg font-semibold">
                <LoaderCircle className="size-5 animate-spin" aria-hidden />
                Waiting for the sale…
              </p>
            ) : (
              <p className="text-lg font-semibold">No sale for it.</p>
            )}
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              <span className="font-mono">{waiting.code}</span> {waiting.title}
            </p>
            {waiting.sortedBox != null && (
              <p className="mt-2 text-sm">One of these already went in show box {waiting.sortedBox}. Scanned the same bag twice?</p>
            )}
            <p className="mt-2 text-sm text-muted-foreground">
              {waitedOut ? "If it didn't sell, put it back in its bin." : "It shows the box as soon as Whatnot sends the sale."}
            </p>
            <div className="mt-3 flex justify-center gap-2">
              {waitedOut && (
                <Button size="sm" variant="outline" onClick={() => setWaiting({ ...waiting, since: Date.now() })}>
                  Keep waiting
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setWaiting(null)}>
                {waiting.sortedBox != null ? "Same bag, never mind" : "It didn't sell"}
              </Button>
            </div>
          </Card>
        )}

        {solo && latest && (
          <Card className="text-center">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Last sale goes in show box</p>
            <p className="text-8xl font-black leading-none tabular-nums">{latest.box ?? "?"}</p>
            <p className="mt-2 text-lg font-semibold">{latest.buyer}</p>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {latest.code && <span className="font-mono">{latest.code} </span>}
              {latest.title}
            </p>
            {latest.unknown && <p className="mt-1 text-sm font-medium text-amber-700">Not in the app: find it by its name.</p>}
          </Card>
        )}

        {feed && (
          <Card padded={false}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3 text-sm">
              <span className="font-medium">
                {feed.buyers.length} buyer{feed.buyers.length === 1 ? "" : "s"}
                {!solo && feed.waiting > 0 ? ` · ${feed.waiting} sold, not in a box yet` : ""}
              </span>
              {feed.owner ? (
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-4" checked={solo} disabled={busy} onChange={(e) => setSolo(e.target.checked)} />
                  Solo mode
                </label>
              ) : (
                solo && <Badge>Solo mode</Badge>
              )}
            </div>
            {feed.recent.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No sales in this show yet.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {feed.recent.map((s) => (
                  <li key={s.id} className={`flex items-center gap-3 p-3 ${s.cancelled ? "opacity-50" : ""}`}>
                    <span className="w-12 shrink-0 text-center text-2xl font-black tabular-nums">{s.box ?? "?"}</span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-1 font-medium">{s.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {s.buyer}
                        {s.saleType === "giveaway" ? " · giveaway" : ""}
                        {s.quantity > 1 ? ` · ${s.sortedUnits}/${s.quantity} in` : ""}
                        {s.cancelled ? " · cancelled" : ""}
                      </span>
                    </span>
                    {!s.cancelled && s.sortedUnits >= s.quantity ? (
                      <Badge tone="success">In</Badge>
                    ) : !s.cancelled && s.unknown && !solo ? (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => byHand(s.id)}>
                        In the box
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {feed && feed.buyers.some((b) => !b.packed) && (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">Buyers and their boxes</summary>
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {feed.buyers
                .filter((b) => !b.packed)
                .map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-2 p-2.5">
                    <span>
                      <span className="font-semibold">{b.boxes.length ? `Box ${b.boxes.join(", ")}` : "No box"}</span> · {b.name} ·{" "}
                      {b.sortedUnits}/{b.units} in
                    </span>
                    <Button size="sm" variant="ghost" disabled={busy || !buyerOf(b.id)} onClick={() => boxFull(b.id)}>
                      Box full
                    </Button>
                  </li>
                ))}
            </ul>
          </details>
        )}
      </div>
    </AppShell>
  );
}
