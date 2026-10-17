"use client";

import { ScanField } from "@/components/ScanField";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/Input";
import { upcMatchKeys } from "@/lib/upcMatch";
import { Ban, ChevronRight, CircleCheck, FileSpreadsheet, Minus, PackageX, Plus, SearchX, ThumbsUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

// Sort station (warehouse mode): one person goes through a load before it's
// listed and pulls the units that won't be listed, so listers only get good
// stock. Scan a UPC, see what the manifest says about it, then tap where it
// goes. Damaged and dud units are logged with the same manifest APIs the
// scan page's "Damaged / expired" and "Dud / unsellable" modes use; good
// units just get counted here (they're logged when a lister saves them).
// Several people can sort the same load at once: counts come from the
// server, refreshed as you go, never from this device alone.

type ManifestSummary = {
  id: string;
  title: string;
  supplier: string;
  createdAt: string;
  _count: { lines: number; items: number };
};

type ManifestLine = {
  id: string;
  upc: string | null;
  description: string;
  expectedQuantity: number;
  receivedUnits: number;
  damagedUnits: number;
  dudUnits: number;
};

type ManifestData = { id: string; title: string; lines: ManifestLine[] };

// One product = every manifest line with the same UPC (a UPC can be split
// across lines/pallets), totaled.
type Product = {
  upc: string;
  description: string;
  expected: number;
  received: number;
  damaged: number;
  dud: number;
  matchKeys: string[];
};

type Kind = "good" | "damaged" | "dud";

type LogEntry = { id: number; kind: Kind; quantity: number; description: string; failed?: boolean };

const SORT_MANIFEST_KEY = "ebay-tool.sortManifestId";
// Counts from other sorters/listers are pulled again when they're older
// than this at scan time.
const REFRESH_AFTER_MS = 20_000;

const KIND_TEXT: Record<Kind, string> = {
  good: "good, to the lister",
  damaged: "damaged / expired",
  dud: "dud / unsellable",
};

function loadSavedManifest(): string | null {
  try {
    return localStorage.getItem(SORT_MANIFEST_KEY);
  } catch {
    return null;
  }
}

function saveManifestChoice(id: string | null) {
  try {
    if (id) localStorage.setItem(SORT_MANIFEST_KEY, id);
    else localStorage.removeItem(SORT_MANIFEST_KEY);
  } catch {
    // Not remembered on this device; fine for this visit.
  }
}

function buildProducts(lines: ManifestLine[]): Product[] {
  const byUpc = new Map<string, Product>();
  for (const line of lines) {
    if (!line.upc) continue;
    const p = byUpc.get(line.upc);
    if (p) {
      p.expected += line.expectedQuantity;
      p.received += line.receivedUnits;
      p.damaged += line.damagedUnits;
      p.dud += line.dudUnits;
    } else {
      byUpc.set(line.upc, {
        upc: line.upc,
        description: line.description,
        expected: line.expectedQuantity,
        received: line.receivedUnits,
        damaged: line.damagedUnits,
        dud: line.dudUnits,
        matchKeys: upcMatchKeys(line.upc),
      });
    }
  }
  return [...byUpc.values()];
}

// Loose barcode match (spreadsheets drop leading zeros and so on, see
// upcMatchKeys). The product sharing the most keys with the scan wins.
function findProduct(products: Product[], code: string): Product | null {
  const keys = new Set(upcMatchKeys(code));
  if (keys.size === 0) return null;
  let best: Product | null = null;
  let bestScore = 0;
  for (const p of products) {
    const score = p.matchKeys.filter((k) => keys.has(k)).length;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

// Short tone so the answer registers without looking at the screen: one
// high beep = on the manifest, two low = not on it. Same as the pick page.
function beep(found: boolean) {
  try {
    const ctx = new AudioContext();
    const tones = found ? [880] : [220, 220];
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
    navigator.vibrate?.(found ? 80 : [80, 60, 80]);
  } catch {
    // No audio (or no permission yet) is fine: the screen shows the answer.
  }
}

function focusScan() {
  requestAnimationFrame(() => document.getElementById("sort-upc")?.focus());
}

export default function SortPage() {
  const [manifestId, setManifestId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : loadSavedManifest()
  );
  const [manifests, setManifests] = useState<ManifestSummary[] | null>(null);
  const [data, setData] = useState<ManifestData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadedAt = useRef(0);

  const [code, setCode] = useState("");
  const [scanned, setScanned] = useState<{ code: string; upc: string | null } | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // This device's sorting so far on this manifest. Good units are only
  // counted here; damaged/dud are also saved to the manifest.
  const [tally, setTally] = useState<Record<Kind, number>>({ good: 0, damaged: 0, dud: 0 });
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);

  useEffect(() => {
    if (manifestId) return;
    fetch("/api/manifests")
      .then((r) => r.json())
      .then((list) => setManifests(Array.isArray(list) ? list : []))
      .catch(() => setManifests([]));
  }, [manifestId]);

  function loadManifest(id: string) {
    return fetch(`/api/manifests/${id}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Couldn't load that manifest.");
        return d as ManifestData;
      })
      .then((d) => {
        loadedAt.current = Date.now();
        setData(d);
        setLoadError(null);
      });
  }

  useEffect(() => {
    if (!manifestId) return;
    loadManifest(manifestId).catch((e) => {
      setLoadError(e instanceof Error ? e.message : "Couldn't load that manifest.");
    });
  }, [manifestId]);

  const products = useMemo(() => (data ? buildProducts(data.lines) : []), [data]);
  // Looked up from the latest data each render, so a refresh updates the
  // counts on screen.
  const product = scanned?.upc ? (products.find((p) => p.upc === scanned.upc) ?? null) : null;

  function pickManifest(id: string | null) {
    saveManifestChoice(id);
    setManifestId(id);
    setData(null);
    setScanned(null);
    setMessage(null);
    setTally({ good: 0, damaged: 0, dud: 0 });
    setLog([]);
    if (!id) setManifests(null);
  }

  function refreshInBackground() {
    if (!manifestId) return;
    loadManifest(manifestId).catch(() => {
      // Keeps showing the last counts; the next scan tries again.
    });
  }

  function handleScan() {
    const raw = code.trim();
    setCode("");
    if (!raw) return;
    // Before the manifest loads everything would read "not on this
    // manifest".
    if (!data) {
      setMessage("Still loading the manifest. Scan it again in a second.");
      focusScan();
      return;
    }
    const found = findProduct(products, raw);
    setScanned({ code: raw, upc: found?.upc ?? null });
    setQuantity("1");
    setMessage(null);
    beep(found != null);
    if (Date.now() - loadedAt.current > REFRESH_AFTER_MS) refreshInBackground();
    focusScan();
  }

  async function record(kind: Kind) {
    if (!scanned || !manifestId || saving) return;
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      setMessage("Enter a quantity of at least 1.");
      return;
    }
    const description = product?.description ?? `UPC ${scanned.code}`;
    const entryId = ++logId.current;
    setMessage(null);

    if (kind !== "good") {
      setSaving(true);
      try {
        // The manifest's own UPC when it matched, so the count lands on
        // that line even if the scan reads the barcode a little
        // differently (the manifest page matches UPCs exactly).
        const res = await fetch(`/api/manifests/${manifestId}/${kind === "damaged" ? "damaged" : "duds"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ upc: product?.upc ?? scanned.code, quantity: qty }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error ?? "Save failed.");
        }
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "Something went wrong. Try again.");
        setLog((prev) => [{ id: entryId, kind, quantity: qty, description, failed: true }, ...prev].slice(0, 12));
        setSaving(false);
        focusScan();
        return;
      }
      setSaving(false);
      refreshInBackground();
    }

    setTally((t) => ({ ...t, [kind]: t[kind] + qty }));
    setLog((prev) => [{ id: entryId, kind, quantity: qty, description }, ...prev].slice(0, 12));
    setQuantity("1");
    setMessage(`Logged ${qty} ${KIND_TEXT[kind]}. Scan the next one.`);
    focusScan();
  }

  if (!manifestId) {
    return (
      <AppShell width="narrow" title="Sort" subtitle="Pull damaged, expired and dud units before listing. Pick the load.">
        {manifests === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {manifests && manifests.length === 0 && (
          <Card>
            <p className="text-sm text-muted-foreground">No manifests yet.</p>
          </Card>
        )}
        {manifests && manifests.length > 0 && (
          <ul className="flex flex-col gap-2">
            {manifests.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => pickManifest(m.id)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left shadow-sm transition-colors hover:bg-muted active:bg-muted"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-50 text-primary">
                    <FileSpreadsheet className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{m.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {m._count.lines} lines · {new Date(m.createdAt).toLocaleDateString()}
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

  const left = product ? product.expected - product.received - product.damaged - product.dud : 0;

  return (
    <AppShell
      focused
      width="narrow"
      title="Sort"
      subtitle={data ? data.title : loadError ? undefined : "Loading…"}
      actions={
        <Button variant="outline" size="sm" onClick={() => pickManifest(null)}>
          Change load
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {loadError && (
          <Alert
            tone="danger"
            action={
              <Button variant="outline" size="sm" onClick={() => pickManifest(null)}>
                Pick another load
              </Button>
            }
          >
            {loadError}
          </Alert>
        )}

        <div className="grid grid-cols-3 gap-2 text-center">
          <TallyTile label="Good" value={tally.good} tone="success" />
          <TallyTile label="Damaged" value={tally.damaged} tone="danger" />
          <TallyTile label="Dud" value={tally.dud} tone="warning" />
        </div>

        <Card>
          <ScanField
            id="sort-upc"
            label="UPC"
            prompt="Scan the item's UPC"
            numeric
            autoFocus
            value={code}
            onChange={setCode}
            onScan={handleScan}
            hint={data ? "Scanning shows what the manifest says about it." : "Loading the manifest…"}
          />
        </Card>

        {scanned && !product && (
          <div role="alert" className="rounded-xl border-2 border-red-300 bg-red-50 p-4 text-red-950">
            <div className="flex gap-2">
              <SearchX className="mt-0.5 size-6 shrink-0 text-red-600" aria-hidden />
              <div className="min-w-0">
                <p className="text-lg font-semibold">Not on this manifest</p>
                <p className="mt-0.5 break-all text-sm tabular-nums text-red-900/80">Scanned: {scanned.code}</p>
                <p className="mt-1 text-sm">
                  Check the barcode, or set it aside. You can still log it as damaged or a dud.
                </p>
              </div>
            </div>
          </div>
        )}

        {product && (
          <Card>
            <p className="font-semibold leading-snug text-foreground">{product.description}</p>
            <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">UPC {product.upc}</p>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center">
              <Count label="Expected" value={product.expected} />
              <Count label="Listed" value={product.received} />
              <Count label="Damaged" value={product.damaged} />
              <Count label="Dud" value={product.dud} />
            </div>
            <p className={cn("mt-2 text-sm font-medium", left > 0 ? "text-foreground" : "text-warning")}>
              {left > 0
                ? `${left} still to sort or list`
                : left === 0
                  ? "All accounted for already. This one may be extra."
                  : `${-left} more than the manifest listed.`}
            </p>
          </Card>
        )}

        {scanned && (
          <>
            <div>
              <p className="mb-1.5 text-sm font-medium text-foreground">How many</p>
              <div className="grid grid-cols-[3.5rem_1fr_3.5rem] gap-2">
                <Button
                  variant="outline"
                  size="icon-xl"
                  aria-label="One less"
                  onClick={() => setQuantity((q) => String(Math.max(1, (Number(q) || 1) - 1)))}
                >
                  <Minus className="size-5" aria-hidden />
                </Button>
                <Input
                  size="lg"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className="text-center"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                />
                <Button
                  variant="outline"
                  size="icon-xl"
                  aria-label="One more"
                  onClick={() => setQuantity((q) => String((Number(q) || 0) + 1))}
                >
                  <Plus className="size-5" aria-hidden />
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Button variant="success" size="xl" block onClick={() => record("good")} disabled={saving}>
                <ThumbsUp className="size-5" aria-hidden />
                Good, pass to lister
              </Button>
              <Button variant="danger" size="xl" block onClick={() => record("damaged")} disabled={saving}>
                <PackageX className="size-5" aria-hidden />
                Damaged / Expired
              </Button>
              <Button variant="warning" size="xl" block onClick={() => record("dud")} disabled={saving}>
                <Ban className="size-5" aria-hidden />
                Dud / Unsellable
              </Button>
            </div>
          </>
        )}

        {message && (
          <div
            role="status"
            className={cn(
              "flex items-start gap-2 rounded-xl border px-4 py-3 text-sm font-medium",
              message.startsWith("Logged")
                ? "border-green-200 bg-green-50 text-green-900"
                : "border-amber-200 bg-amber-50 text-amber-950"
            )}
          >
            {message.startsWith("Logged") && <CircleCheck className="mt-0.5 size-5 shrink-0 text-green-600" aria-hidden />}
            {message}
          </div>
        )}

        {log.length > 0 && (
          <section>
            <SectionHeader title="Just now" action={<Badge>{log.length}</Badge>} />
            <ul className="divide-y divide-border rounded-xl border border-border bg-surface text-sm">
              {log.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                  <span
                    className={cn(
                      "w-16 shrink-0 text-xs font-semibold",
                      e.failed
                        ? "text-muted-foreground line-through"
                        : e.kind === "good"
                          ? "text-success"
                          : e.kind === "damaged"
                            ? "text-danger"
                            : "text-warning"
                    )}
                  >
                    {e.kind === "good" ? "Good" : e.kind === "damaged" ? "Damaged" : "Dud"} ×{e.quantity}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{e.description}</span>
                  {e.failed && <span className="shrink-0 text-xs text-danger">Not saved</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </AppShell>
  );
}

const TALLY_TONES = {
  success: "border-green-200 bg-green-50 text-green-800",
  danger: "border-red-200 bg-red-50 text-red-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
} as const;

function TallyTile({ label, value, tone }: { label: string; value: number; tone: keyof typeof TALLY_TONES }) {
  return (
    <div className={cn("rounded-lg border px-2 py-2", TALLY_TONES[tone])}>
      <p className="text-xs font-medium">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-background px-1 py-2">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}
