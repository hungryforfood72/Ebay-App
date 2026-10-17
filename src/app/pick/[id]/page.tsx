"use client";

import BarcodeScanner from "@/components/BarcodeScanner";
import { ScanField } from "@/components/ScanField";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { upcMatchKeys } from "@/lib/upcMatch";
import { Camera, ChevronDown, CircleCheck, CircleHelp, CircleX } from "lucide-react";
import { useEffect, useMemo, useState, use as usePromise } from "react";

type Product = {
  key: string;
  decision: "take" | "leave";
  description: string;
  upc: string | null;
  itemNumbers: string[];
  matchKeys: string[];
  reason: string | null;
};

type PickData = {
  title: string;
  products: Product[];
  foundKeys: string[];
  recent: { id: string; code: string; productKey: string | null; decision: string; scannedAt: string }[];
};

type Result = { code: string; product: Product | null; alreadyFound: boolean };

const normItem = (s: string) => s.trim().toLowerCase().replace(/^0+/, "");

// A barcode first (see upcMatchKeys for the spreadsheet mangling it
// survives), then the supplier's Item # for products with no UPC.
// Sizes of one product can have stored codes one digit apart (European
// 13-digit codes the sheet cut short), so the product sharing the most
// keys with the scan wins; TAKE breaks a true tie.
function findProduct(products: Product[], code: string): Product | null {
  const keys = new Set(upcMatchKeys(code));
  const scored = products
    .map((p) => ({ p, score: p.matchKeys.filter((k) => keys.has(k)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.p.decision === "take" ? -1 : 1) - (b.p.decision === "take" ? -1 : 1));
  if (scored.length > 0) return scored[0].p;
  const byItem = products.filter((p) => p.itemNumbers.some((n) => normItem(n) === normItem(code)));
  return byItem.find((p) => p.decision === "take") ?? byItem[0] ?? null;
}

// Short tone so the answer registers without looking at the screen.
function beep(kind: "take" | "leave" | "unknown") {
  try {
    const ctx = new AudioContext();
    const tones = kind === "take" ? [880] : kind === "leave" ? [220, 220] : [440];
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
    navigator.vibrate?.(kind === "take" ? 80 : [80, 60, 80]);
  } catch {
    // No audio (or no permission yet) is fine: the screen shows the answer.
  }
}

async function fetchPickData(id: string): Promise<PickData> {
  const res = await fetch(`/api/manifests/${id}/pick`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Couldn't load the pick list.");
  return data as PickData;
}

// Pick mode for a consignment load, at the supplier's: scan a box and it
// says TAKE or LEAVE. Cristian takes all of every TAKE product, so there
// are no counts, just which TAKE products have turned up so far.
export default function PickPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [data, setData] = useState<PickData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [found, setFound] = useState<Set<string>>(new Set());
  const [cameraOpen, setCameraOpen] = useState(false);
  const [showRemaining, setShowRemaining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPickData(id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setFound(new Set(d.foundKeys));
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load the pick list."));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const takeProducts = useMemo(() => data?.products.filter((p) => p.decision === "take") ?? [], [data]);
  const remaining = takeProducts.filter((p) => !found.has(p.key));

  function handleScan(raw: string) {
    const scanned = raw.trim();
    setCode("");
    if (!scanned || !data) return;
    const product = findProduct(data.products, scanned);
    const decision = product?.decision ?? "unknown";
    setResult({ code: scanned, product, alreadyFound: product != null && found.has(product.key) });
    beep(decision);
    if (product?.decision === "take") setFound((prev) => new Set(prev).add(product.key));
    fetch(`/api/manifests/${id}/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: scanned, productKey: product?.key ?? null, decision }),
    }).catch(() => {
      // Logging is only for the "found" progress; the answer already showed.
    });
    document.getElementById("pick-code")?.focus();
  }

  return (
    <AppShell
      title={data ? `Pick: ${data.title}` : "Pick"}
      subtitle="Scan each box. Green = take it, red = leave it."
      width="narrow"
    >
      <div className="flex flex-col gap-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {data && (
          <>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-medium text-foreground">
                  Found {takeProducts.length - remaining.length} of {takeProducts.length} to take
                </span>
                <span className="text-muted-foreground">{data.products.length - takeProducts.length} to leave</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-success transition-[width] duration-300"
                  style={{
                    width: `${takeProducts.length ? ((takeProducts.length - remaining.length) / takeProducts.length) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>

            <ScanField
              id="pick-code"
              label="Barcode or Item #"
              prompt="Scan a box"
              autoFocus
              value={code}
              onChange={setCode}
              onScan={() => handleScan(code)}
              hint="No UPC on it? Type his Item # instead."
            />
            <Button variant="outline" onClick={() => setCameraOpen(true)}>
              <Camera className="size-4" aria-hidden />
              Use the camera
            </Button>

            {result && <ResultPanel result={result} />}

            {remaining.length > 0 && (
              <Card padded={false}>
                <button
                  type="button"
                  onClick={() => setShowRemaining((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 p-4 text-left text-sm font-medium text-foreground"
                >
                  Still to find ({remaining.length})
                  <ChevronDown className={cn("size-4 transition-transform", showRemaining && "rotate-180")} aria-hidden />
                </button>
                {showRemaining && (
                  <ul className="divide-y divide-border border-t border-border text-sm">
                    {remaining.map((p) => (
                      <li key={p.key} className="px-4 py-2.5">
                        <p className="text-foreground">{p.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {p.itemNumbers.length ? `Item # ${p.itemNumbers.join(" / ")}` : ""}
                          {p.itemNumbers.length && p.upc ? " · " : ""}
                          {p.upc ? `UPC ${p.upc}` : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {data.recent.length > 0 && !result && (
              <section>
                <SectionHeader title="Last scans" />
                <ul className="divide-y divide-border rounded-xl border border-border text-sm">
                  {data.recent.map((r) => {
                    const p = data.products.find((x) => x.key === r.productKey);
                    return (
                      <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2">
                        <span className="min-w-0 truncate text-foreground">{p?.description ?? r.code}</span>
                        <span
                          className={cn(
                            "shrink-0 text-xs font-semibold uppercase",
                            r.decision === "take" ? "text-success" : r.decision === "leave" ? "text-danger" : "text-warning"
                          )}
                        >
                          {r.decision === "unknown" ? "not listed" : r.decision}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {cameraOpen && (
        <BarcodeScanner
          onDetected={(scanned) => {
            setCameraOpen(false);
            handleScan(scanned);
          }}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </AppShell>
  );
}

function ResultPanel({ result }: { result: Result }) {
  const { product } = result;
  const tone = !product ? "unknown" : product.decision;
  const Icon = tone === "take" ? CircleCheck : tone === "leave" ? CircleX : CircleHelp;
  return (
    <div
      role="status"
      className={cn(
        "rounded-2xl p-5 text-white shadow-sm",
        tone === "take" ? "bg-success" : tone === "leave" ? "bg-danger" : "bg-warning"
      )}
    >
      <div className="flex items-center gap-3">
        <Icon className="size-10 shrink-0" aria-hidden />
        <p className="text-4xl font-bold tracking-tight">
          {tone === "take" ? "TAKE" : tone === "leave" ? "LEAVE" : "NOT LISTED"}
        </p>
      </div>
      <p className="mt-3 text-lg font-semibold leading-snug">{product?.description ?? `Nothing on this manifest matches ${result.code}`}</p>
      <p className="mt-1 text-sm opacity-90">
        {product
          ? [
              product.itemNumbers.length ? `Item # ${product.itemNumbers.join(" / ")}` : null,
              product.decision === "leave" ? product.reason : null,
              result.alreadyFound ? "Already scanned one of these" : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : "Your call. Try the camera or his Item # if the barcode looks wrong."}
      </p>
    </div>
  );
}
