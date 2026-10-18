"use client";

import BarcodeScanner from "@/components/BarcodeScanner";
import { ScanField } from "@/components/ScanField";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { cn } from "@/components/ui/cn";
import { Camera, ChevronDown, CircleCheck, CircleX, Search } from "lucide-react";
import { use as usePromise, useEffect, useMemo, useState } from "react";

// ONE-TIME TOOL (Cristian, 2026-10-17): the leftover Costco food loads
// have no UPCs, only Costco's Item #. Find a product by Item # or by name,
// see TAKE / LEAVE (consignment pick list from the Analyzer, same as
// /pick/[id]), and when it's a TAKE and in hand, scan its UPC: that saves
// it onto the manifest so listing it later lines up with its retail and
// cost, and counts it as found.
// To remove the tool: delete src/app/one-time and src/app/api/one-time.

type Product = {
  key: string;
  decision: "take" | "leave";
  description: string;
  upc: string | null;
  itemNumbers: string[];
  reason: string | null;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/^0+/, "");

function search(products: Product[], query: string): Product[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byItem = products.filter((p) => p.itemNumbers.some((n) => norm(n) === norm(q) || norm(n).startsWith(norm(q))));
  const words = q.split(/\s+/).filter(Boolean);
  const byName = products.filter((p) => !byItem.includes(p) && words.every((w) => p.description.toLowerCase().includes(w)));
  return [...byItem, ...byName].sort((a, b) => (a.decision === b.decision ? 0 : a.decision === "take" ? -1 : 1)).slice(0, 25);
}

export default function ItemLookupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [title, setTitle] = useState("");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [found, setFound] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);
  const [upc, setUpc] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [showRemaining, setShowRemaining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch(`/api/manifests/${id}/pick`), fetch(`/api/one-time/item-lookup/${id}`)])
      .then(async ([pickRes, savedRes]) => {
        const pick = await pickRes.json();
        if (!pickRes.ok) throw new Error(pick.error ?? "Couldn't load the pick list.");
        const s = await savedRes.json();
        if (cancelled) return;
        setTitle(pick.title);
        setProducts(pick.products);
        setFound(new Set(pick.foundKeys));
        setSaved(s.saved ?? {});
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load."));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const results = useMemo(() => (products ? search(products, query) : []), [products, query]);
  const take = useMemo(() => products?.filter((p) => p.decision === "take") ?? [], [products]);
  const remaining = take.filter((p) => !found.has(p.key));

  function choose(p: Product) {
    setSelected(p);
    setUpc("");
    setMessage(null);
  }

  async function saveUpc(raw: string) {
    const code = raw.trim();
    if (!selected || !code) return;
    const itemNumber = selected.itemNumbers[0];
    if (!itemNumber) {
      setMessage({ ok: false, text: "This product has no Item # on the manifest, so there's nothing to attach the UPC to." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/one-time/item-lookup/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemNumber, upc: code, productKey: selected.key, decision: selected.decision }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't save the UPC.");
      setSaved((prev) => ({ ...prev, ...Object.fromEntries(selected.itemNumbers.map((n) => [n, json.upc])) }));
      setFound((prev) => new Set(prev).add(selected.key));
      setMessage({ ok: true, text: `Saved UPC ${json.upc} for ${selected.description}. Marked found.` });
      setUpc("");
      setQuery("");
      document.getElementById("lookup-query")?.focus();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Couldn't save the UPC." });
    } finally {
      setSaving(false);
    }
  }

  const savedUpc = selected ? selected.itemNumbers.map((n) => saved[n]).find(Boolean) : null;

  return (
    <AppShell title={title ? `Find by Item #: ${title}` : "Find by Item #"} subtitle="One-time tool for the leftover food" width="narrow">
      <div className="flex flex-col gap-5">
        {error && <Alert tone="danger">{error}</Alert>}
        {products && (
          <>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-medium text-foreground">
                  Found {take.length - remaining.length} of {take.length} to take
                </span>
                <span className="text-muted-foreground">{products.length - take.length} to leave</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-success transition-[width] duration-300"
                  style={{ width: `${take.length ? ((take.length - remaining.length) / take.length) * 100 : 0}%` }}
                />
              </div>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id="lookup-query"
                autoFocus
                className="pl-9"
                placeholder="Item # or product name (e.g. 1846994 or snackies)"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(null);
                }}
              />
            </div>

            {query.trim() && !selected && (
              <Card padded={false} className="divide-y divide-border">
                {results.length === 0 && <p className="p-4 text-sm text-muted-foreground">Nothing on this manifest matches &ldquo;{query}&rdquo;.</p>}
                {results.map((p) => (
                  <button key={p.key} type="button" onClick={() => choose(p)} className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted">
                    <span className={cn("w-14 shrink-0 text-xs font-bold uppercase", p.decision === "take" ? "text-success" : "text-danger")}>{p.decision}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-foreground">{p.description}</span>
                      <span className="block text-xs text-muted-foreground">Item # {p.itemNumbers.join(" / ") || "none"}</span>
                    </span>
                    {found.has(p.key) && <CircleCheck className="size-4 shrink-0 text-success" aria-label="Found" />}
                  </button>
                ))}
              </Card>
            )}

            {selected && (
              <div className={cn("rounded-2xl p-5 text-white shadow-sm", selected.decision === "take" ? "bg-success" : "bg-danger")} role="status">
                <div className="flex items-center gap-3">
                  {selected.decision === "take" ? <CircleCheck className="size-10 shrink-0" aria-hidden /> : <CircleX className="size-10 shrink-0" aria-hidden />}
                  <p className="text-4xl font-bold tracking-tight">{selected.decision === "take" ? "TAKE" : "LEAVE"}</p>
                </div>
                <p className="mt-3 text-lg font-semibold leading-snug">{selected.description}</p>
                <p className="mt-1 text-sm opacity-90">
                  {[`Item # ${selected.itemNumbers.join(" / ") || "none"}`, selected.decision === "leave" ? selected.reason : null, savedUpc ? `UPC ${savedUpc} on file` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            )}

            {selected?.decision === "take" && (
              <Card className="flex flex-col gap-3">
                <SectionHeader title={savedUpc ? "Scan again to change the UPC" : "Found it? Scan its UPC"} description="The barcode on the product itself. It's saved to the manifest and marks it found." />
                <ScanField
                  id="lookup-upc"
                  label="UPC"
                  prompt="Scan the product's barcode"
                  autoFocus
                  value={upc}
                  onChange={setUpc}
                  onScan={() => saveUpc(upc)}
                  hint={saving ? "Saving…" : "Or type the numbers under the barcode."}
                />
                <Button variant="outline" onClick={() => setCameraOpen(true)} disabled={saving}>
                  <Camera className="size-4" aria-hidden />
                  Use the camera
                </Button>
              </Card>
            )}

            {message && <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert>}

            {remaining.length > 0 && (
              <Card padded={false}>
                <button
                  type="button"
                  onClick={() => setShowRemaining((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 p-4 text-left text-sm font-medium text-foreground"
                >
                  TAKE items still to find ({remaining.length})
                  <ChevronDown className={cn("size-4 transition-transform", showRemaining && "rotate-180")} aria-hidden />
                </button>
                {showRemaining && (
                  <ul className="divide-y divide-border border-t border-border text-sm">
                    {remaining.map((p) => (
                      <li key={p.key}>
                        <button type="button" onClick={() => choose(p)} className="w-full px-4 py-2.5 text-left hover:bg-muted">
                          <span className="block text-foreground">{p.description}</span>
                          <span className="block text-xs text-muted-foreground">Item # {p.itemNumbers.join(" / ") || "none"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </>
        )}
        {!products && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      </div>

      {cameraOpen && (
        <BarcodeScanner
          onDetected={(scanned) => {
            setCameraOpen(false);
            saveUpc(scanned);
          }}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </AppShell>
  );
}
