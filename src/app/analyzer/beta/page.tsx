"use client";

import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import { ChevronRight, Copy, FlaskConical } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type ManifestRow = {
  id: string;
  title: string;
  createdAt: string;
  _count: { lines: number };
  maxBid?: number | null;
  recommendation?: "buy" | "dont_buy" | null;
};

// Compare Analyzers: run the current Analyzer (priced without eBay's data
// about other sellers, see BetaPricing in src/lib/sourcingAgent.ts) on a
// copy of a manifest, to compare with the legacy Analyzer's call on the
// same load. Started 2026-10-18 as the "Analyzer Beta", before the
// compliant Analyzer became the live one.
export default function AnalyzerBetaPage() {
  const router = useRouter();
  const [copies, setCopies] = useState<ManifestRow[] | null>(null);
  const [sources, setSources] = useState<{ bought: ManifestRow[]; candidates: ManifestRow[] } | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/manifests?beta=true")
      .then((r) => r.json())
      .then(setCopies);
    Promise.all([
      fetch("/api/manifests").then((r) => r.json()),
      fetch("/api/manifests?purchased=false").then((r) => r.json()),
    ]).then(([bought, candidates]) => setSources({ bought, candidates }));
  }, []);

  async function copy() {
    if (!sourceId) return;
    setCopying(true);
    setError(null);
    try {
      const res = await fetch(`/api/manifests/${sourceId}/beta-copy`, { method: "POST" });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error ?? "Couldn't copy that manifest.");
      router.push(`/analyzer/${result.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setCopying(false);
    }
  }

  return (
    <AppShell
      title="Compare Analyzers"
      subtitle="Run the current Analyzer on a copy of a load the legacy Analyzer already judged, and see them side by side."
    >
      <div className="flex flex-col gap-6">
        <Alert tone="info" title="How the current Analyzer works">
          It never looks at other sellers&apos; eBay listings, prices or sold counts. Prices come from your own sales,
          the manifest&apos;s retail times what your own sales actually get as a share of retail, and web research of
          store prices (with eBay&apos;s sites blocked) for the most valuable items. Sell speed comes from your own sales
          or, for the most valuable items, demand outside eBay (Amazon sales, rank, reviews). The dud, holiday,
          banned-item and pack-size checks are the same as the legacy Analyzer. As your own sales grow, they take
          over more of every estimate.
        </Alert>

        <Card>
          <SectionHeader title="Copy a manifest to compare" />
          <p className="mb-3 text-sm text-muted-foreground">
            Makes a separate copy to run the current Analyzer on, next to the legacy Analyzer&apos;s call on the original.
            The original isn&apos;t changed, and a copy can&apos;t be bought or bid on. (On a manifest still in the
            Analyzer you can also just hit &ldquo;Run legacy&rdquo; there.)
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full max-w-md">
              <label htmlFor="beta-source" className="mb-1.5 block text-sm font-medium text-foreground">
                Manifest
              </label>
              <Select
                id="beta-source"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                disabled={!sources}
              >
                <option value="">{sources ? "Choose a manifest…" : "Loading…"}</option>
                {sources && sources.bought.length > 0 && (
                  <optgroup label="Bought">
                    {sources.bought.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title} ({m._count.lines} lines)
                      </option>
                    ))}
                  </optgroup>
                )}
                {sources && sources.candidates.length > 0 && (
                  <optgroup label="In the Analyzer">
                    {sources.candidates.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title} ({m._count.lines} lines)
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </div>
            <Button onClick={copy} disabled={!sourceId || copying}>
              <Copy className="size-4" aria-hidden />
              {copying ? "Copying…" : "Copy and compare"}
            </Button>
          </div>
          {error && <p className="mt-3 text-sm font-medium text-danger">{error}</p>}
        </Card>

        <section>
          <SectionHeader title="Comparison copies" action={copies && copies.length > 0 ? <Badge>{copies.length}</Badge> : undefined} />
          {copies === null && <p className="text-sm text-muted-foreground">Loading…</p>}
          {copies && copies.length === 0 && (
            <Card>
              <p className="text-sm text-muted-foreground">No comparison copies yet.</p>
            </Card>
          )}
          {copies && copies.length > 0 && (
            <ul className="flex flex-col gap-2">
              {copies.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/analyzer/${c.id}`}
                    className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm transition-colors hover:bg-muted active:bg-muted"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-50 text-primary">
                      <FlaskConical className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{c.title}</p>
                      <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                        <span>{c._count.lines} lines</span>
                        <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                      </p>
                      {c.recommendation && (
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                          <Badge tone={c.recommendation === "buy" ? "success" : "danger"}>
                            {c.recommendation === "buy" ? "Buy" : "Don't buy"}
                          </Badge>
                          {c.maxBid != null && c.recommendation === "buy" && (
                            <span className="tabular-nums text-muted-foreground">max {money(c.maxBid)}</span>
                          )}
                        </p>
                      )}
                    </div>
                    <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
