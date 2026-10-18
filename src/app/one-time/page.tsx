"use client";

import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import Link from "next/link";
import { useEffect, useState } from "react";

// ONE-TIME TOOL (Cristian, 2026-10-17): start page for the leftover Costco
// food item lookup. Not in the menu on purpose; open /one-time directly.
// To remove the tool: delete src/app/one-time and src/app/api/one-time.

type Load = { id: string; title: string; createdAt: string; lines: number; analyzed: boolean };

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
    <AppShell title="One-time: find by Item #" subtitle="Leftover food: TAKE or LEAVE by Item #, then scan the UPC" width="narrow">
      <div className="flex flex-col gap-4">
        <Alert tone="info">
          Pick the consignment load. It needs the Analyzer to have finished on it, since that&apos;s where TAKE and LEAVE come from.
        </Alert>
        {error && <Alert tone="danger">{error}</Alert>}
        {loads && loads.length === 0 && (
          <Card>
            <p className="text-sm text-muted-foreground">No consignment loads yet. Send the combined manifest from the Analyzer to Manifests as a consignment load first.</p>
          </Card>
        )}
        {loads?.map((l) => (
          <Link key={l.id} href={`/one-time/item-lookup/${l.id}`}>
            <Card className="transition-colors hover:bg-muted">
              <p className="font-semibold text-foreground">{l.title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{l.lines} lines</span>
                {l.analyzed ? <Badge tone="success">Analyzed</Badge> : <Badge tone="warning">Run the Analyzer first</Badge>}
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </AppShell>
  );
}
