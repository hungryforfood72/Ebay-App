"use client";

import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import Link from "next/link";
import { useEffect, useState } from "react";

// ONE-TIME TOOL (Cristian, 2026-10-17): start page for counting the
// leftover Costco food. Not in the menu on purpose; open /one-time.
// To remove the tool: delete src/app/one-time and src/app/api/one-time.

type Load = { id: string; title: string; createdAt: string; lines: number; analyzer: string | null };

export default function OneTimePage() {
  const [loads, setLoads] = useState<Load[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/one-time/manifests")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Couldn't load.");
        setLoads(json.manifests);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load."));
  }, []);

  return (
    <AppShell title="One-time: count the leftover food" subtitle="Scan each product's UPC and count it, then run the Analyzer" width="narrow">
      <div className="flex flex-col gap-4">
        <Alert tone="info">
          1. Upload &ldquo;Combined - all 3 Costco loads.csv&rdquo; in the Analyzer (Item # as the SKU column), but don&apos;t run it yet.
          2. Open it below and count. 3. Done counting, then run the Analyzer. 4. Come back here for Sell / Dud.
        </Alert>
        {error && <Alert tone="danger">{error}</Alert>}
        {loads?.map((l) => (
          <Link key={l.id} href={`/one-time/item-lookup/${l.id}`}>
            <Card className="transition-colors hover:bg-muted">
              <p className="font-semibold text-foreground">{l.title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{l.lines} products</span>
                {l.analyzer === "complete" ? (
                  <Badge tone="success">Analyzed</Badge>
                ) : l.analyzer === "running" ? (
                  <Badge tone="warning">Analyzer running</Badge>
                ) : (
                  <Badge>Not analyzed yet</Badge>
                )}
              </div>
            </Card>
          </Link>
        ))}
        {!loads && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      </div>
    </AppShell>
  );
}
