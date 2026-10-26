"use client";

import { ScanField } from "@/components/ScanField";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import type { PullItem, PullScanResponse } from "@/lib/warehouse/pulls";
import { CircleCheck, CircleX, Info, MapPin, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// Pulling stock off the shelves, scan by scan (Cristian, 2026-10-26; see
// src/lib/warehouse/pulls.ts). Laid out like Pick orders so it fits the
// handheld: what to grab next, scan its label, green = it's one to pull.

const SCAN_ID = "pull-scan";
const AUTO_REFRESH_MS = 60_000;

type Result = { tone: "good" | "bad" | "info"; headline: string; detail?: string; note?: string | null };

function beep(kind: Result["tone"]) {
  try {
    const ctx = new AudioContext();
    const tones = kind === "good" ? [880] : kind === "bad" ? [220, 220] : [440];
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      const start = ctx.currentTime + i * 0.2;
      osc.start(start);
      osc.stop(start + 0.14);
    });
    navigator.vibrate?.(kind === "good" ? 80 : kind === "bad" ? [80, 60, 80] : 40);
  } catch {
    // No audio: the screen shows the answer.
  }
}

function focusScan() {
  setTimeout(() => document.getElementById(SCAN_ID)?.focus(), 0);
}

function reasonText(reason: string | null): string {
  return reason === "rx_return" ? "Rx only: set it aside to go back to the supplier." : "Expired: take it off the shelf.";
}

function placeText(item: PullItem): string {
  const bin = item.bins[0];
  if (bin) return bin.oversized ? `Oversized shelf ${bin.shelfLabel}` : bin.shelfLabel ? `Shelf ${bin.shelfLabel} · ${bin.binCode}` : `${bin.binCode} (not shelved)`;
  return item.legacyShelf ? `Shelf ${item.legacyShelf}` : "No location on record";
}

const isOpen = (p: PullItem) => p.left > 0 || p.bins.length === 0;

export default function PullsPage() {
  const [items, setItems] = useState<PullItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [currentBin, setCurrentBin] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState(0);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await fetch("/api/pulls", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't load the pull list.");
      setItems(data.items as PullItem[]);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load the pull list.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Sets state only after the fetch comes back.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = setInterval(() => {
      if (!document.hidden && !busyRef.current) void load();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  function show(r: Result) {
    setResult(r);
    beep(r.tone);
  }

  const open = (items ?? []).filter(isOpen);
  const unitsLeft = open.reduce((n, p) => n + Math.max(p.left, p.bins.length ? 0 : 1), 0);
  const unitsDone = open.reduce((n, p) => n + p.pulled, 0) + doneCount;
  const next = open.find((p) => p.id === selectedId) ?? open[0] ?? null;

  async function send(body: Record<string, unknown>) {
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/pulls/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, binCode: currentBin }),
      });
      const json = (await res.json()) as PullScanResponse | { error: string };
      if (!res.ok || "error" in json) throw new Error("error" in json ? json.error : "Couldn't save that.");
      if (json.ok) {
        const total = json.pulled + json.left;
        setSelectedId(null);
        if (json.done) {
          setDoneCount((n) => n + json.pulled);
          setItems((list) => (list ? list.filter((p) => p.id !== json.itemId) : list));
        } else {
          setItems((list) =>
            list
              ? list.map((p) =>
                  p.id === json.itemId
                    ? {
                        ...p,
                        left: json.left,
                        pulled: json.pulled,
                        bins: p.bins
                          .map((b) => (b.binCode === json.takenFromBin ? { ...b, units: b.units - 1 } : b))
                          .filter((b) => b.units > 0),
                      }
                    : p
                )
              : list
          );
        }
        show({
          tone: "good",
          headline: json.done ? "Correct. All pulled" : `Correct, pull it (${json.pulled} of ${total})`,
          detail: json.done ? reasonText(json.reason) : `${json.left} more to find.`,
          note: [json.manual ? "Confirmed by tap, not a scan." : null, json.binNote].filter(Boolean).join(" ") || null,
        });
      } else if (json.code === "not_on_list") {
        const s = json.scannedItem;
        show({
          tone: "bad",
          headline: "Not on the pull list",
          detail: s ? `That's ${s.code} (${s.title}). Leave it.` : json.reason,
          note: s?.location ? `It lives at ${s.location}.` : null,
        });
      } else {
        show({ tone: "bad", headline: json.code === "already_done" ? "Already pulled" : "Wrong scan", detail: json.reason });
        if (json.code === "already_done") void load();
      }
    } catch (e) {
      show({ tone: "bad", headline: "Didn't save", detail: e instanceof Error ? e.message : "Try that scan again." });
    } finally {
      busyRef.current = false;
      setBusy(false);
      focusScan();
    }
  }

  async function handleScan(raw: string) {
    const scanned = normalizeCode(raw);
    setCode("");
    if (!scanned || busyRef.current) return;
    if (classifyScan(scanned) === "bin") {
      setCurrentBin(scanned);
      show({ tone: "info", headline: `At bin ${scanned}`, detail: "Pulls come off this bin's count first." });
      focusScan();
      return;
    }
    await send({ scannedCode: scanned, itemId: next?.id ?? null });
  }

  async function cantFindRest(item: PullItem) {
    if (!confirm(`Finish pulling ${item.code} without the ${item.left} you couldn't find? They come off the bin counts as not found.`)) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${item.id}/acknowledge-shelf-pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notFound: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't finish that pull.");
      setItems((list) => (list ? list.filter((p) => p.id !== item.id) : list));
      show({ tone: "info", headline: `${item.code} finished`, detail: `${item.left} not found, taken off the bin counts.` });
    } catch (e) {
      show({ tone: "bad", headline: "Didn't save", detail: e instanceof Error ? e.message : "Try again." });
    } finally {
      busyRef.current = false;
      setBusy(false);
      focusScan();
    }
  }

  return (
    <AppShell
      title="Pull from shelves"
      subtitle={<span className="hidden sm:inline">Scan each one you pull. Green means it&apos;s one to pull.</span>}
      width="narrow"
      actions={
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden />
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-3 sm:gap-5">
        {loadError && <Alert tone="danger">{loadError}</Alert>}
        {!items && !loadError && <p className="text-sm text-muted-foreground">Loading the pull list…</p>}

        {items && (
          <>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-medium text-foreground">
                  {unitsLeft} to pull, {unitsDone} done
                </span>
                <span className="text-muted-foreground">
                  {open.length} {open.length === 1 ? "listing" : "listings"}
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-success transition-[width] duration-300"
                  style={{ width: `${unitsLeft + unitsDone ? (unitsDone / (unitsLeft + unitsDone)) * 100 : 0}%` }}
                />
              </div>
            </div>

            {result && <ResultPanel result={result} onClose={() => setResult(null)} />}

            <ScanField
              id={SCAN_ID}
              label="Item label"
              prompt="Scan the label on what you pull"
              autoFocus
              value={code}
              onChange={setCode}
              onScan={() => handleScan(code)}
              compact={result != null && !currentBin}
              hint={
                currentBin ? (
                  <span className="inline-flex items-center gap-1">
                    At {currentBin}.
                    <button type="button" className="font-medium text-primary underline" onClick={() => setCurrentBin(null)}>
                      Clear
                    </button>
                  </span>
                ) : (
                  "Scan the label on each one you take off the shelf."
                )
              }
            />

            {next && (
              <NextCard
                item={next}
                selected={selectedId === next.id}
                busy={busy}
                onClear={() => setSelectedId(null)}
                onFound={() => send({ itemId: next.id, manual: true })}
                onCantFind={() => cantFindRest(next)}
              />
            )}

            {open.length === 0 && (
              <Card>
                <p className="flex items-center gap-2 text-sm text-foreground">
                  <CircleCheck className="size-5 text-success" aria-hidden />
                  Nothing left to pull.
                </p>
              </Card>
            )}

            {open.length > 1 && (
              <section>
                <SectionHeader title={`To pull (${open.length})`} description="In walking order: shelf, then bin." />
                <ul className="flex flex-col gap-2">
                  {open.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(p.id);
                          focusScan();
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border bg-surface px-3 py-2 text-left shadow-sm",
                          p.id === next?.id ? "border-primary" : "border-border"
                        )}
                      >
                        <Thumb src={p.photo} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">{p.title}</p>
                          <p className="text-xs text-muted-foreground">{placeText(p)}</p>
                        </div>
                        <p className="text-lg font-bold text-foreground">
                          {p.pulled}/{p.pulled + p.left || 1}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

function NextCard({
  item,
  selected,
  busy,
  onClear,
  onFound,
  onCantFind,
}: {
  item: PullItem;
  selected: boolean;
  busy: boolean;
  onClear: () => void;
  onFound: () => void;
  onCantFind: () => void;
}) {
  const facts = [item.verifyBy === "label" ? item.code : null, item.expiration ? `exp ${item.expiration}` : null, item.condition, item.pack]
    .filter(Boolean)
    .join(" · ");
  const more = item.bins.slice(1);
  return (
    <Card className={cn("border-2", selected ? "border-primary" : "border-border")}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{selected ? "Pulling this one" : "Next to grab"}</p>
        {selected && (
          <button type="button" onClick={onClear} className="inline-flex items-center gap-1 text-xs font-medium text-primary">
            <X className="size-3.5" aria-hidden />
            Back to the list order
          </button>
        )}
      </div>
      <p className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
        <MapPin className="size-6 shrink-0 text-primary" aria-hidden />
        {placeText(item)}
      </p>
      {item.bins[0] && (
        <p className="mt-0.5 text-sm text-muted-foreground">
          {item.bins[0].units} {item.bins[0].units === 1 ? "unit" : "units"} in this bin
        </p>
      )}
      <div className="mt-3 flex gap-3">
        <Thumb src={item.photo} size="size-20" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-foreground">{item.title}</p>
          {facts && <p className="mt-0.5 text-xs text-muted-foreground">{facts}</p>}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {item.bins.length ? `${item.pulled} of ${item.pulled + item.left} pulled` : "Everything on that shelf"}
          </p>
          <p className={cn("mt-1 text-xs font-medium", item.reason === "rx_return" ? "text-danger" : "text-amber-700")}>
            {reasonText(item.reason)}
          </p>
          {item.verifyBy === "upc" && <p className="mt-1 text-xs font-medium text-amber-700">No label: scan its barcode (UPC).</p>}
        </div>
      </div>
      {more.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Also in:{" "}
          {more
            .map((b) => `${b.binCode}${b.shelfLabel ? ` (shelf ${b.shelfLabel})` : ""}, ${b.units} ${b.units === 1 ? "unit" : "units"}`)
            .join(" · ")}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-2">
        {item.verifyBy === "tap" && (
          <Button variant="outline" block onClick={onFound} disabled={busy}>
            <CircleCheck className="size-4" aria-hidden />
            Nothing to scan? Found it
          </Button>
        )}
        {item.bins.length > 0 && (
          <button type="button" onClick={onCantFind} disabled={busy} className="text-sm font-medium text-muted-foreground underline">
            Can&apos;t find the rest
          </button>
        )}
      </div>
    </Card>
  );
}

function ResultPanel({ result, onClose }: { result: Result; onClose: () => void }) {
  const Icon = result.tone === "good" ? CircleCheck : result.tone === "bad" ? CircleX : Info;
  return (
    <div
      role="status"
      className={cn(
        "relative rounded-xl px-3 py-2.5 text-white shadow-sm",
        result.tone === "good" ? "bg-success" : result.tone === "bad" ? "bg-danger" : "bg-primary"
      )}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="absolute right-1 top-1 grid size-8 place-items-center rounded-md text-white/80 hover:bg-white/10"
      >
        <X className="size-4" aria-hidden />
      </button>
      <div className="flex items-start gap-2 pr-7">
        <Icon className="mt-0.5 size-6 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-lg font-bold leading-tight">{result.headline}</p>
          {result.detail && <p className="mt-0.5 text-base font-semibold leading-snug">{result.detail}</p>}
          {result.note && <p className="mt-0.5 text-xs leading-snug opacity-90">{result.note}</p>}
        </div>
      </div>
    </div>
  );
}

function Thumb({ src, size = "size-12" }: { src: string | null | undefined; size?: string }) {
  if (!src) return <div className={cn(size, "shrink-0 rounded-lg border border-border bg-muted")} aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={cn(size, "shrink-0 rounded-lg border border-border object-cover")} />;
}
