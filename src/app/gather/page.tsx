"use client";

import { ScanField } from "@/components/ScanField";
import { SortBoxesCard } from "@/components/SortBoxesCard";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/Input";
import { boxShortName } from "@/lib/warehouse/codes";
import type { SortLocation } from "@/lib/warehouse/sortBoxes";
import { ChevronRight, CircleCheck, CircleX, FileSpreadsheet, Info, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// The lister's helper (Cristian, 2026-11-01). Before, the lister scanned a
// product on the List page and then walked the sort boxes to grab the rest
// of it. Now a helper does that ahead of time: scan any item out of a sort
// box, the page says which other boxes hold more of it, the helper pulls
// them all and leaves them together for the lister. Same pull as the List
// page (src/app/api/sort-boxes/gather), so when the lister scans it there,
// it already shows "Already gathered" and sends nobody to the boxes.

const SCAN_ID = "gather-scan";
const MANIFEST_KEY = "ebay-tool.gatherManifestId";
const NO_BOX = "Not boxed";

type Load = { manifestId: string; title: string; products: number; units: number };
type BoxLeft = { boxCode: string; products: number; units: number };
type Pull = { upc: string; pulled: { boxCode: string; units: number }[]; locations: SortLocation[] };
type GatherResponse = {
  product: { key: string; description: string | null };
  pulled: { boxCode: string; units: number }[];
  locations: SortLocation[];
  boxes: BoxLeft[];
};
type SearchResult = { key: string; description: string; label: string };
type Result = { tone: "good" | "bad" | "info"; headline: string; detail?: string; note?: string | null; product?: string | null };

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

function readStored(): string | null {
  try {
    return localStorage.getItem(MANIFEST_KEY);
  } catch {
    return null;
  }
}

function writeStored(value: string | null) {
  try {
    if (value) localStorage.setItem(MANIFEST_KEY, value);
    else localStorage.removeItem(MANIFEST_KEY);
  } catch {
    // Private mode: the load just isn't remembered.
  }
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? fallback);
  return data as T;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What the helper reads after a scan.
function resultFor(data: GatherResponse): Result {
  const product = data.product.description;
  const total = data.pulled.reduce((sum, p) => sum + p.units, 0);
  if (data.locations.length === 0) {
    return {
      tone: "bad",
      headline: "Not in the sort boxes",
      detail: "Nothing of this was sorted into a box on this load.",
      note: "Wrong load, or it skipped sorting. Set it aside for the lister to check.",
      product,
    };
  }
  if (total === 0) {
    const before = data.locations.reduce((sum, l) => sum + l.pulled, 0);
    const by = data.locations.find((l) => l.pulled > 0 && l.gatheredBy)?.gatheredBy;
    return {
      tone: "info",
      headline: "Already gathered",
      detail: `${plural(before, "unit")} already pulled${by ? ` by ${by}` : ""}. Put this one with that pile.`,
      product,
    };
  }
  // Boxes this scan took the last units out of (not reused, so done).
  const stillFull = new Set(data.boxes.map((b) => b.boxCode));
  const emptied = data.pulled
    .map((p) => p.boxCode)
    .filter((c) => c !== NO_BOX && !stillFull.has(c))
    .map(boxShortName);
  const where = data.pulled.map((p) => `${boxShortName(p.boxCode)} x${p.units}`).join(" · ");
  return {
    tone: "good",
    headline: total === 1 ? "Just this one" : `Gather all ${total}`,
    detail: total === 1 ? "No more in the boxes. Put it on the table for the lister." : `${where} (counting the one in your hand)`,
    note: emptied.length > 0 ? `${emptied.join(", ")} ${emptied.length === 1 ? "is" : "are"} empty now.` : null,
    product,
  };
}

export default function GatherPage() {
  const [manifestId, setManifestId] = useState<string | null>(() => (typeof window === "undefined" ? null : readStored()));
  const [loads, setLoads] = useState<Load[] | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<BoxLeft[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [code, setCode] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [pull, setPull] = useState<Pull | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  // This device's gathering so far on this load.
  const [tally, setTally] = useState({ products: 0, units: 0 });

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const pickManifest = useCallback((id: string | null) => {
    writeStored(id);
    setManifestId(id);
    setTitle(null);
    setBoxes(null);
    setLoadError(null);
    setResult(null);
    setPull(null);
    setTally({ products: 0, units: 0 });
    if (!id) setLoads(null);
  }, []);

  // No load yet: list the ones with units in sort boxes, and pick it
  // straight away when there's only one.
  useEffect(() => {
    if (manifestId) return;
    let cancelled = false;
    fetch("/api/sort-boxes/gather", { cache: "no-store" })
      .then((r) => readJson<{ loads: Load[] }>(r, "Couldn't load the loads."))
      .then((d) => {
        if (cancelled) return;
        if (d.loads.length === 1) pickManifest(d.loads[0].manifestId);
        else setLoads(d.loads);
      })
      .catch((e) => !cancelled && setLoadError(errorText(e, "Couldn't load the loads.")));
    return () => {
      cancelled = true;
    };
  }, [manifestId, pickManifest]);

  const loadBoxes = useCallback(
    async (manual = false) => {
      if (!manifestId) return;
      if (manual) setRefreshing(true);
      try {
        const d = await readJson<{ title: string; boxes: BoxLeft[] }>(
          await fetch(`/api/sort-boxes/gather?manifestId=${encodeURIComponent(manifestId)}`, { cache: "no-store" }),
          "Couldn't load the boxes."
        );
        setTitle(d.title);
        setBoxes(d.boxes);
        setLoadError(null);
      } catch (e) {
        setLoadError(errorText(e, "Couldn't load the boxes."));
      } finally {
        setRefreshing(false);
      }
    },
    [manifestId]
  );

  useEffect(() => {
    // Sets state only after the fetch comes back.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBoxes();
  }, [loadBoxes]);

  useEffect(() => {
    if (!searchOpen || !manifestId) return;
    const q = searchQ.trim();
    if (q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const d = await readJson<{ results: SearchResult[] }>(
          await fetch(`/api/sort/search?manifestId=${encodeURIComponent(manifestId)}&q=${encodeURIComponent(q)}`),
          "Couldn't search."
        );
        if (!cancelled) {
          setSearchResults(d.results);
          setSearchError(null);
        }
      } catch (e) {
        if (!cancelled) setSearchError(errorText(e, "Couldn't search."));
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [searchOpen, searchQ, manifestId]);

  function show(r: Result) {
    setResult(r);
    beep(r.tone);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQ("");
    setSearchResults(null);
    setSearchError(null);
    focusScan();
  }

  async function gather(scanned: string) {
    if (!manifestId || !scanned || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const data = await readJson<GatherResponse>(
        await fetch("/api/sort-boxes/gather", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifestId, code: scanned }),
        }),
        "Couldn't check that one."
      );
      const units = data.pulled.reduce((sum, p) => sum + p.units, 0);
      if (units > 0) setTally((t) => ({ products: t.products + 1, units: t.units + units }));
      setBoxes(data.boxes);
      setPull(data.locations.length > 0 ? { upc: data.product.key, pulled: data.pulled, locations: data.locations } : null);
      show(resultFor(data));
    } catch (e) {
      setPull(null);
      show({ tone: "bad", headline: "Didn't save", detail: errorText(e, "Try that scan again.") });
    } finally {
      busyRef.current = false;
      setBusy(false);
      focusScan();
    }
  }

  function handleScan() {
    const scanned = code.trim();
    setCode("");
    void gather(scanned);
  }

  // "Left some here": units go back on that box's count.
  async function putBack(boxCode: string, units: number): Promise<string | null> {
    if (!pull || !manifestId) return "Scan the product again.";
    try {
      const d = await readJson<{ locations: SortLocation[] }>(
        await fetch("/api/sort-boxes/put-back", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifestId, upc: pull.upc, boxCode, units }),
        }),
        "Couldn't put them back."
      );
      setPull((prev) => (prev ? { ...prev, locations: d.locations } : prev));
      setTally((t) => ({ ...t, units: Math.max(0, t.units - units) }));
      void loadBoxes();
      return null;
    } catch (e) {
      return errorText(e, "Couldn't put them back.");
    }
  }

  // "Count was off": the box really held `found`, not what the sort said.
  async function fixCount(boxCode: string, found: number): Promise<string | null> {
    if (!pull || !manifestId) return "Scan the product again.";
    try {
      const d = await readJson<{ locations: SortLocation[]; delta: number }>(
        await fetch("/api/sort-boxes/fix-count", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifestId, upc: pull.upc, boxCode, found, page: "gather" }),
        }),
        "Couldn't fix the count."
      );
      setPull((prev) => (prev ? { ...prev, locations: d.locations } : prev));
      setTally((t) => ({ ...t, units: Math.max(0, t.units + d.delta) }));
      void loadBoxes();
      return null;
    } catch (e) {
      return errorText(e, "Couldn't fix the count.");
    }
  }

  if (!manifestId) {
    return (
      <AppShell width="narrow" title="Gather for listing" subtitle="Pull everything out of the sort boxes for the lister. Pick the load.">
        {loadError && <Alert tone="danger">{loadError}</Alert>}
        {loads === null && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}
        {loads && loads.length === 0 && (
          <Card>
            <p className="flex items-center gap-2 text-sm text-foreground">
              <CircleCheck className="size-5 text-success" aria-hidden />
              Nothing in the sort boxes right now.
            </p>
          </Card>
        )}
        {loads && loads.length > 0 && (
          <ul className="flex flex-col gap-2">
            {loads.map((l) => (
              <li key={l.manifestId}>
                <button
                  type="button"
                  onClick={() => pickManifest(l.manifestId)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left shadow-sm transition-colors hover:bg-muted active:bg-muted"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-50 text-primary">
                    <FileSpreadsheet className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{l.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {plural(l.units, "unit")} in the boxes · {plural(l.products, "product")}
                    </span>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </AppShell>
    );
  }

  const unitsLeft = (boxes ?? []).reduce((sum, b) => sum + b.units, 0);

  return (
    <AppShell
      title="Gather for listing"
      subtitle={<span className="hidden sm:inline">Scan anything from a sort box. Grab every box it says, keep them together for the lister.</span>}
      width="narrow"
      actions={
        <Button variant="outline" size="sm" onClick={() => loadBoxes(true)} disabled={refreshing}>
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden />
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-3 sm:gap-5">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="min-w-0 truncate font-medium text-foreground">{title ?? "Loading…"}</span>
          <button type="button" className="shrink-0 font-medium text-primary underline" onClick={() => pickManifest(null)}>
            Change load
          </button>
        </div>

        {loadError && <Alert tone="danger">{loadError}</Alert>}

        {boxes && (
          <p className="text-sm text-muted-foreground">
            {unitsLeft > 0 ? `${plural(unitsLeft, "unit")} left in ${plural(boxes.length, "box", "boxes")}` : "The sort boxes are empty."}
            {tally.units > 0 && ` · you gathered ${plural(tally.units, "unit")} of ${plural(tally.products, "product")}`}
          </p>
        )}

        {result && <ResultPanel result={result} onClose={() => setResult(null)} />}

        {pull && <SortBoxesCard pull={pull} onPutBack={putBack} onFixCount={fixCount} headline={false} />}

        <ScanField
          id={SCAN_ID}
          label="Product barcode"
          prompt="Scan any item from a sort box"
          autoFocus
          value={code}
          onChange={setCode}
          onScan={handleScan}
          compact={result != null}
          hint={
            <span className="inline-flex items-center gap-1">
              {busy ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Checking…
                </>
              ) : (
                "No barcode?"
              )}
              {!busy && (
                <button type="button" className="font-medium text-primary underline" onClick={() => setSearchOpen(true)}>
                  Search by name
                </button>
              )}
            </span>
          }
        />

        {searchOpen && (
          <Card padded={false} className="p-3">
            <div className="flex gap-2">
              <Input
                autoFocus
                type="search"
                enterKeyHint="search"
                placeholder="Type part of the name"
                aria-label="Search this load by name"
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
              />
              <Button variant="outline" onClick={closeSearch}>
                Cancel
              </Button>
            </div>
            {searchError ? (
              <p className="mt-2 text-sm text-danger">{searchError}</p>
            ) : searchQ.trim().length < 2 ? (
              <p className="mt-2 text-sm text-muted-foreground">Type at least 2 letters.</p>
            ) : searchResults === null ? (
              <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden /> Searching…
              </p>
            ) : searchResults.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Nothing on this load matches.</p>
            ) : (
              <ul className="mt-2 flex max-h-80 flex-col gap-1.5 overflow-y-auto">
                {searchResults.map((r) => (
                  <li key={r.key}>
                    <button
                      type="button"
                      onClick={() => {
                        closeSearch();
                        void gather(r.key);
                      }}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-left active:bg-muted"
                    >
                      <span className="line-clamp-2 block text-sm font-medium text-foreground">{r.description}</span>
                      <span className="block text-xs text-muted-foreground">{r.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {boxes && boxes.length > 0 && (
          <section>
            <SectionHeader title={`Boxes still holding stuff (${boxes.length})`} description="Work through one box at a time until it's empty." />
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {boxes.map((b) => (
                <li key={b.boxCode} className="rounded-xl border border-border bg-surface px-3 py-2 shadow-sm">
                  <p className="font-semibold text-foreground">{boxShortName(b.boxCode)}</p>
                  <p className="text-xs text-muted-foreground">
                    {plural(b.units, "unit")} · {plural(b.products, "product")}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {boxes && boxes.length === 0 && (
          <Card>
            <p className="flex items-center gap-2 text-sm text-foreground">
              <CircleCheck className="size-5 text-success" aria-hidden />
              Everything on this load is gathered.
            </p>
          </Card>
        )}
      </div>
    </AppShell>
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
          <p className="text-2xl font-bold leading-tight">{result.headline}</p>
          {result.detail && <p className="mt-0.5 text-lg font-semibold leading-snug">{result.detail}</p>}
          {result.product && <p className="mt-1 line-clamp-2 text-sm leading-snug opacity-90">{result.product}</p>}
          {result.note && <p className="mt-0.5 text-sm font-medium leading-snug">{result.note}</p>}
        </div>
      </div>
    </div>
  );
}
