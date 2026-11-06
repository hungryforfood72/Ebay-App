"use client";

import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Input, Select } from "@/components/ui/Input";
import { Gavel, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

// Whatnot (Cristian, 2026-11-06; owner only): which Whatnot bins go in
// which show, cross-listing everything live on eBay/Shopify as buy-it-now,
// the eBay-to-Whatnot category map, and recent Whatnot sales with where
// each item is. Everything goes through Whatnot's own API (whatnotSync.ts).

type Show = { id: string; title: string; status: string; startsAt: string | null; url: string };
type BinRow = { code: string; shelf: string | null; units: number; onWhatnot: number; show: { id: string; title: string; startsAt: string | null } | null };
type CategoryRule = { match: string; categoryId: string; categoryName: string };
type CategoryMap = { rules: CategoryRule[]; defaultId: string | null; defaultName: string | null };
type Overview = {
  connected: boolean;
  webhookReady: boolean;
  shows: Show[];
  showsError: string | null;
  bins: BinRow[];
  crossList: boolean;
  categoryMap: CategoryMap;
  counts: { onWhatnot: number; waiting: number };
  skipped: { reason: string; count: number }[];
  failed: { id: string; sku: string; finalTitle: string | null; whatnotError: string; whatnotOnly: boolean }[];
  sales: { id: string; order: string; soldAt: string; quantity: number; revenue: number; sku: string; title: string | null; bins: string[] }[];
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "no time set";

async function post(body: Record<string, unknown>) {
  const r = await fetch("/api/whatnot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? "Something went wrong.");
  return data;
}

export default function WhatnotPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/whatnot", { cache: "no-store" });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(json?.error ?? "Couldn't load Whatnot.");
    return json as Overview;
  }, []);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function run(label: string, body: Record<string, unknown>, done?: (result: Record<string, unknown>) => string) {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const result = await post(body);
      if (done) setMessage(done(result));
      setData(await load());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <AppShell title="Whatnot">
        {error ? <Alert tone="danger">{error}</Alert> : <p className="text-sm text-muted-foreground">Loading…</p>}
      </AppShell>
    );
  }

  const binsByShow = new Map<string, BinRow[]>();
  for (const b of data.bins) if (b.show) binsByShow.set(b.show.id, [...(binsByShow.get(b.show.id) ?? []), b]);

  return (
    <AppShell
      title="Whatnot"
      subtitle={`${data.counts.onWhatnot} on Whatnot · ${data.counts.waiting} waiting to cross-list`}
      actions={
        <Button variant="outline" size="sm" disabled={busy !== null || !data.connected} onClick={() => run("sync", { action: "sync" }, (r) => `Synced. ${r.listed ?? 0} new on Whatnot.${Array.isArray(r.errors) && r.errors.length ? ` ${r.errors.length} problem(s), see below.` : ""}`)}>
          <RefreshCw className="size-4" aria-hidden />
          {busy === "sync" ? "Syncing…" : "Sync now"}
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {!data.connected && (
          <Alert tone="warning" title="Whatnot isn't connected">
            Add WHATNOT_API_TOKEN in Vercel (a personal access token from Whatnot&apos;s developer dashboard), then redeploy.
          </Alert>
        )}
        {data.connected && !data.webhookReady && (
          <Alert tone="warning" title="Sale alerts aren't set up">
            Add WHATNOT_WEBHOOK_SECRET in Vercel so Whatnot sales come in instantly. Until then they come in with the 10-minute sync.
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        {message && <Alert tone="success">{message}</Alert>}

        <Card>
          <SectionHeader title="Shows and bins" description="Each Whatnot bin goes in one show. Its Whatnot auctions are put in that show." />
          {data.showsError && <Alert tone="danger" className="mb-3">{data.showsError}</Alert>}
          {data.shows.length === 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">No upcoming shows. Schedule one in the Whatnot app, then refresh.</p>
          ) : (
            <div className="mb-4 flex flex-col gap-2">
              {data.shows.map((s) => (
                <div key={s.id} className="rounded-lg border border-border p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <Gavel className="size-4 text-purple-600" aria-hidden />
                    {s.title}
                    {s.status === "live" && <Badge tone="danger">Live</Badge>}
                    <span className="font-normal text-muted-foreground">{when(s.startsAt)}</span>
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {(binsByShow.get(s.id) ?? []).map((b) => b.code).join(", ") || "No bins yet"}
                  </p>
                </div>
              ))}
            </div>
          )}
          {data.bins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Whatnot bins yet. Make them on the Bins page.</p>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {data.bins.map((b) => (
                <div key={b.code} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                  <div className="min-w-32">
                    <p className="font-mono font-semibold">{b.code}</p>
                    <p className="text-xs text-muted-foreground">
                      {b.units} unit{b.units === 1 ? "" : "s"} · {b.onWhatnot} on Whatnot{b.shelf ? ` · ${b.shelf}` : ""}
                    </p>
                  </div>
                  <Select
                    className="min-w-56 flex-1"
                    value={b.show?.id ?? ""}
                    disabled={busy !== null || !data.connected}
                    onChange={(e) =>
                      run(`bin-${b.code}`, { action: "assign", binCode: b.code, showId: e.target.value || null }, (r) =>
                        Array.isArray(r.errors) && r.errors.length ? `Saved, but: ${r.errors.join(" ")}` : `${b.code} saved.`
                      )
                    }
                    aria-label={`Show for ${b.code}`}
                  >
                    <option value="">No show</option>
                    {b.show && !data.shows.some((s) => s.id === b.show!.id) && (
                      <option value={b.show.id}>{b.show.title} (over)</option>
                    )}
                    {data.shows.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title} · {when(s.startsAt)}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionHeader
            title="eBay and Shopify items on Whatnot"
            description="Everything live goes in your Whatnot shop as buy-it-now at the Shopify price. A sale anywhere takes it off everywhere else."
          />
          <label className="mb-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={data.crossList}
              disabled={busy !== null || !data.connected}
              onChange={(e) => run("cross", { action: "settings", crossList: e.target.checked }, () => (e.target.checked ? "Cross-listing is on. It lists about 20 every 10 minutes." : "Cross-listing is off. Items already on Whatnot stay there."))}
            />
            <span>
              List them on Whatnot
              <span className="block text-xs text-muted-foreground">
                {data.counts.waiting} waiting. Skipped: anything Whatnot doesn&apos;t allow, close to its date, past-date, or local pickup.
              </span>
            </span>
          </label>
          {data.skipped.length > 0 && (
            <div className="mb-3 text-sm">
              <p className="font-medium">Not going on Whatnot</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {data.skipped.map((s) => (
                  <li key={s.reason}>
                    {s.reason}: {s.count}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.failed.length > 0 && (
            <div className="text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-red-700">Whatnot refused these</p>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("retry", { action: "retry" }, (r) => `${r.cleared ?? 0} will be tried again on the next sync.`)}>
                  Try them again
                </Button>
              </div>
              <ul className="mt-1 space-y-1">
                {data.failed.map((f) => (
                  <li key={f.id} className="rounded bg-red-50 px-2 py-1 text-red-900">
                    <span className="font-medium">{f.finalTitle ?? f.sku}</span>: {f.whatnotError}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <CategoryCard
          map={data.categoryMap}
          disabled={busy !== null}
          connected={data.connected}
          onSave={(map) => run("map", { action: "settings", categoryMap: map }, () => "Categories saved.")}
          onError={setError}
        />

        <Card>
          <SectionHeader title="Recent Whatnot sales" description="Already taken off eBay and Shopify. Where to find each one." />
          {data.sales.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Whatnot sales through the API yet.</p>
          ) : (
            <div className="divide-y divide-border text-sm">
              {data.sales.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="font-medium">{s.title ?? s.sku}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.order} · {when(s.soldAt)} · {s.quantity} × ${(s.revenue / Math.max(1, s.quantity)).toFixed(2)}
                    </p>
                  </div>
                  <span className="font-mono text-xs">{s.bins.join(", ") || "Not in a bin"}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}

// Which Whatnot category each eBay category goes in. Whatnot's API has no
// category list, so the ids come from listings already on Whatnot ("Find
// my Whatnot categories").
function CategoryCard({
  map,
  disabled,
  connected,
  onSave,
  onError,
}: {
  map: CategoryMap;
  disabled: boolean;
  connected: boolean;
  onSave: (map: CategoryMap) => void;
  onError: (message: string) => void;
}) {
  const [rules, setRules] = useState<CategoryRule[]>(map.rules);
  const [defaultId, setDefaultId] = useState(map.defaultId ?? "");
  const [defaultName, setDefaultName] = useState(map.defaultName ?? "");
  const [found, setFound] = useState<{ id: string; name: string | null; count: number; example: string }[] | null>(null);
  const [finding, setFinding] = useState(false);

  async function find() {
    setFinding(true);
    try {
      const r = await post({ action: "categories" });
      setFound(r.categories ?? []);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setFinding(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Categories"
        description="Whatnot needs a category for every listing. A rule matches text in the item's eBay category (like &quot;Makeup&quot; or &quot;Hair Care&quot;)."
        action={
          <Button size="sm" variant="outline" onClick={find} disabled={finding || !connected}>
            {finding ? "Looking…" : "Find my Whatnot categories"}
          </Button>
        }
      />
      {found && (
        <div className="mb-3 rounded-lg bg-muted p-3 text-xs">
          {found.length === 0 ? (
            <p>No listings on Whatnot to read categories from. List one item in the Whatnot app in each category you use, then try again.</p>
          ) : (
            <ul className="space-y-1">
              {found.map((c) => (
                <li key={c.id}>
                  <span className="font-mono">{c.id}</span> · {c.name ?? "unnamed"} · {c.count} listing{c.count === 1 ? "" : "s"} (e.g. {c.example})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {rules.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="w-44" placeholder="eBay category text" value={r.match} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)))} aria-label="eBay category text" />
            <Input className="w-44" placeholder="Whatnot category id" value={r.categoryId} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, categoryId: e.target.value } : x)))} aria-label="Whatnot category id" />
            <Input className="w-40" placeholder="Name (for you)" value={r.categoryName} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, categoryName: e.target.value } : x)))} aria-label="Category name" />
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label="Remove rule">
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        ))}
        <div>
          <Button size="sm" variant="ghost" onClick={() => setRules([...rules, { match: "", categoryId: "", categoryName: "" }])}>
            Add a rule
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="w-44 text-sm text-muted-foreground">Everything else</span>
          <Input className="w-44" placeholder="Whatnot category id" value={defaultId} onChange={(e) => setDefaultId(e.target.value)} aria-label="Default Whatnot category id" />
          <Input className="w-40" placeholder="Name (for you)" value={defaultName} onChange={(e) => setDefaultName(e.target.value)} aria-label="Default category name" />
        </div>
        <div>
          <Button size="sm" disabled={disabled} onClick={() => onSave({ rules, defaultId: defaultId || null, defaultName: defaultName || null })}>
            Save categories
          </Button>
        </div>
      </div>
    </Card>
  );
}
