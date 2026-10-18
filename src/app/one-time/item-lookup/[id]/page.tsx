"use client";

import BarcodeScanner from "@/components/BarcodeScanner";
import { ScanField } from "@/components/ScanField";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { cn } from "@/components/ui/cn";
import { Camera, CircleCheck, Search } from "lucide-react";
import Link from "next/link";
import { use as usePromise, useEffect, useMemo, useState } from "react";

// ONE-TIME TOOL (Cristian, 2026-10-17): count the leftover Costco food
// (Item # but no UPC on the manifest). Find a product by Item # or name,
// scan its UPC, type how many; "Done counting" drops what wasn't found;
// then the Analyzer runs and this page shows Sell / Dud.
// To remove the tool: delete src/app/one-time and src/app/api/one-time.

type Line = { id: string; supplierSku: string | null; description: string; upc: string | null; expectedQuantity: number; retailPrice: number };
type Counted = Record<string, { count: number; upc: string | null; originalQty: number; by: string | null; at: string }>;
type ResultRow = { description: string; upc: string | null; itemNumbers: string[]; units: number; sellUnits: number; reason: string; netPerUnit: number | null; monthsToSell: number | null };
type Data = {
  title: string;
  lines: Line[];
  counted: Counted;
  finished: boolean;
  analyzer: string | null;
  results: { sell: ResultRow[]; dud: ResultRow[]; profit: number | null } | null;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/^0+/, "");

function search(lines: Line[], query: string): Line[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byItem = lines.filter((l) => l.supplierSku && (norm(l.supplierSku) === norm(q) || norm(l.supplierSku).startsWith(norm(q))));
  const words = q.split(/\s+/).filter(Boolean);
  const byName = lines.filter((l) => !byItem.includes(l) && words.every((w) => l.description.toLowerCase().includes(w)));
  return [...byItem, ...byName].slice(0, 25);
}

async function post(id: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/one-time/item-lookup/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Couldn't save.");
  return json;
}

export default function CountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Line | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/one-time/item-lookup/${id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't load.");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load.");
    }
  }

  useEffect(() => {
    // Initial load, not a reaction to state we own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const results = useMemo(() => (data ? search(data.lines, query) : []), [data, query]);
  const countedIds = Object.keys(data?.counted ?? {});
  const found = countedIds.filter((k) => (data?.counted[k]?.count ?? 0) > 0).length;

  function afterSave(text: string, counted: Counted, newLine?: Line) {
    setData((d) => (d ? { ...d, counted, lines: newLine ? [...d.lines, newLine] : d.lines } : d));
    setMessage({ ok: true, text });
    setSelected(null);
    setAdding(false);
    setQuery("");
    setTimeout(() => document.getElementById("count-query")?.focus(), 50);
  }

  async function finish() {
    if (!data) return;
    const notFound = data.lines.length - found;
    if (!confirm(`Done counting? This removes the ${notFound} product(s) you didn't find (or counted 0) from this manifest, so the Analyzer only checks what you have. ${found} stay.`)) return;
    try {
      const json = await post(id, { action: "finish" });
      setMessage({ ok: true, text: `Done. Kept ${json.kept ?? found}, removed ${json.removed}. Now run the Analyzer.` });
      load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Couldn't finish." });
    }
  }

  if (error) {
    return (
      <AppShell title="Count the leftover food" width="narrow">
        <Alert tone="danger">{error}</Alert>
      </AppShell>
    );
  }
  if (!data) {
    return (
      <AppShell title="Count the leftover food" width="narrow">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    );
  }

  return (
    <AppShell title={`Count: ${data.title}`} subtitle="One-time tool for the leftover food" width="narrow">
      <div className="flex flex-col gap-5">
        {message && <Alert tone={message.ok ? "success" : "danger"}>{message.text}</Alert>}

        {!data.finished ? (
          <>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-medium text-foreground">
                  Counted {countedIds.length} of {data.lines.length}
                </span>
                <span className="text-muted-foreground">{found} found</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-success" style={{ width: `${data.lines.length ? (countedIds.length / data.lines.length) * 100 : 0}%` }} />
              </div>
            </div>

            {!selected && !adding && (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    id="count-query"
                    autoFocus
                    className="pl-9"
                    placeholder="Item # or name (e.g. 1846994 or snackies)"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setMessage(null);
                    }}
                  />
                </div>
                {query.trim() && (
                  <Card padded={false} className="divide-y divide-border">
                    {results.length === 0 && (
                      <p className="p-4 text-sm text-muted-foreground">Nothing on the manifest matches &ldquo;{query}&rdquo;. Use &ldquo;Not on the list&rdquo; below.</p>
                    )}
                    {results.map((l) => {
                      const c = data.counted[l.id];
                      return (
                        <button key={l.id} type="button" onClick={() => setSelected(l)} className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted">
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm text-foreground">{l.description}</span>
                            <span className="block text-xs text-muted-foreground">
                              Item # {l.supplierSku ?? "none"} · manifest had {c?.originalQty ?? l.expectedQuantity}
                            </span>
                          </span>
                          {c && <Badge tone={c.count > 0 ? "success" : "neutral"}>{c.count > 0 ? `${c.count} counted` : "none left"}</Badge>}
                        </button>
                      );
                    })}
                  </Card>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => setAdding(true)}>
                    Not on the list? Add it
                  </Button>
                  <Button variant="success" onClick={finish} disabled={found === 0}>
                    <CircleCheck className="size-4" aria-hidden />
                    Done counting
                  </Button>
                </div>
              </>
            )}

            {selected && (
              <CountCard
                line={selected}
                counted={data.counted[selected.id]}
                onCancel={() => setSelected(null)}
                onSave={async (upc, count) => {
                  const json = await post(id, { action: "count", lineId: selected.id, upc, count });
                  afterSave(count > 0 ? `${selected.description}: ${count} counted.` : `${selected.description}: marked none left.`, json.counted);
                }}
              />
            )}

            {adding && (
              <AddCard
                onCancel={() => setAdding(false)}
                onSave={async (fields) => {
                  const json = await post(id, { action: "add", ...fields });
                  afterSave(`Added ${fields.description}: ${fields.count} counted.`, json.counted, json.line);
                }}
              />
            )}
          </>
        ) : (
          <Results data={data} id={id} />
        )}
      </div>
    </AppShell>
  );
}

function UpcField({ value, onChange, onScan }: { value: string; onChange: (v: string) => void; onScan: () => void }) {
  const [camera, setCamera] = useState(false);
  return (
    <>
      <ScanField id="count-upc" label="UPC" prompt="Scan the product's barcode" autoFocus value={value} onChange={onChange} onScan={onScan} hint="Or type the numbers under the barcode." />
      <Button variant="outline" onClick={() => setCamera(true)}>
        <Camera className="size-4" aria-hidden />
        Use the camera
      </Button>
      {camera && (
        <BarcodeScanner
          onDetected={(code) => {
            setCamera(false);
            onChange(code);
            document.getElementById("count-qty")?.focus();
          }}
          onClose={() => setCamera(false)}
        />
      )}
    </>
  );
}

function CountCard({
  line,
  counted,
  onSave,
  onCancel,
}: {
  line: Line;
  counted: Counted[string] | undefined;
  onSave: (upc: string, count: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [upc, setUpc] = useState(counted?.upc ?? line.upc ?? "");
  const [qty, setQty] = useState(counted ? String(counted.count) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(count: number) {
    setSaving(true);
    setError(null);
    try {
      await onSave(upc, count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <p className="text-lg font-semibold text-foreground">{line.description}</p>
        <p className="text-sm text-muted-foreground">
          Item # {line.supplierSku ?? "none"} · manifest had {counted?.originalQty ?? line.expectedQuantity}
        </p>
      </div>
      <UpcField value={upc} onChange={setUpc} onScan={() => document.getElementById("count-qty")?.focus()} />
      <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
        How many do you have?
        <Input
          id="count-qty"
          type="number"
          inputMode="numeric"
          min={0}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && qty !== "") save(Number(qty));
          }}
        />
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button size="lg" onClick={() => save(Number(qty))} disabled={saving || qty === "" || Number(qty) < 1}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="outline" onClick={() => save(0)} disabled={saving}>
          None left
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Back
        </Button>
      </div>
    </Card>
  );
}

function AddCard({
  onSave,
  onCancel,
}: {
  onSave: (f: { upc: string; description: string; count: number; unitRetail: number | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [upc, setUpc] = useState("");
  const [description, setDescription] = useState("");
  const [qty, setQty] = useState("");
  const [retail, setRetail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave({ upc, description, count: Number(qty), unitRetail: retail ? Number(retail) : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <SectionHeader title="Not on the list" description="Something you have that isn't on the Costco manifests." />
      <UpcField value={upc} onChange={setUpc} onScan={() => document.getElementById("add-name")?.focus()} />
      <Input id="add-name" placeholder="What is it? (brand, product, size)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="flex gap-2">
        <Input id="count-qty" type="number" inputMode="numeric" min={1} placeholder="How many" value={qty} onChange={(e) => setQty(e.target.value)} />
        <Input type="number" inputMode="decimal" min={0} step="0.01" placeholder="Retail each (optional)" value={retail} onChange={(e) => setRetail(e.target.value)} />
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button size="lg" onClick={save} disabled={saving || !upc || !description.trim() || !(Number(qty) > 0)}>
          {saving ? "Saving…" : "Add it"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Back
        </Button>
      </div>
    </Card>
  );
}

function Results({ data, id }: { data: Data; id: string }) {
  if (!data.results) {
    return (
      <Card className="flex flex-col gap-3">
        <p className="font-semibold text-foreground">Counting is done: {data.lines.length} products kept.</p>
        <p className="text-sm text-muted-foreground">
          {data.analyzer === "running"
            ? "The Analyzer is running. Come back when it finishes."
            : "Next: run the Analyzer on it. When it finishes, Sell / Dud shows up here."}
        </p>
        <Link href={`/analyzer/${id}`} className="text-sm font-medium text-primary underline">
          Open it in the Analyzer
        </Link>
      </Card>
    );
  }
  const money = (n: number | null) => (n == null ? null : `$${n.toFixed(2)}`);
  const rows = (list: ResultRow[], sell: boolean) =>
    list.map((r, i) => (
      <li key={`${r.description}-${i}`} className="px-4 py-2.5">
        <p className="text-sm text-foreground">{r.description}</p>
        <p className="text-xs text-muted-foreground">
          {[
            r.itemNumbers.length ? `Item # ${r.itemNumbers.join(" / ")}` : null,
            r.upc ? `UPC ${r.upc}` : null,
            sell ? `list ${r.sellUnits} of ${r.units}` : `${r.units} on hand`,
            sell && r.netPerUnit != null ? `~${money(r.netPerUnit)} each after fees + label` : null,
            r.reason,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </li>
    ));
  return (
    <>
      {data.results.profit != null && (
        <Alert tone="success">
          {data.results.sell.length} worth listing, {data.results.dud.length} duds. About {money(data.results.profit)} after eBay fees and labels if the
          suggested amounts sell.
        </Alert>
      )}
      <section>
        <SectionHeader title={`Sell (${data.results.sell.length})`} description="Worth listing. Slow sellers say how many to list; the rest are in-person / local." />
        <ul className={cn("divide-y divide-border rounded-xl border border-border")}>{rows(data.results.sell, true)}</ul>
      </section>
      <section>
        <SectionHeader title={`Dud (${data.results.dud.length})`} description="Not worth eBay: sell in person, locally, or on the past-date page." />
        <ul className="divide-y divide-border rounded-xl border border-border">{rows(data.results.dud, false)}</ul>
      </section>
    </>
  );
}
