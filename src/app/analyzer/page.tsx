"use client";

import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { cn } from "@/components/ui/cn";
import { ChartColumn, ChevronDown, ChevronRight, Gavel, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Candidate = {
  id: string;
  title: string;
  supplier: string;
  totalLandedCost?: string | null;
  createdAt: string;
  _count: { lines: number; items: number };
  bidStatus: "active" | "lost" | "won" | null;
  bidAmount: number | null;
  bidPlacedAt: string | null;
  bidClosedAt: string | null;
  // From the latest completed sourcing evaluation, if any.
  maxBid: number | null;
  recommendation: "buy" | "dont_buy" | null;
};

const SUPPLIER_LABELS: Record<string, string> = {
  bstock: "BStock",
  liquidation_com: "Liquidation.com",
  unknown: "Unknown",
};

// Separate from /manifests on purpose — that page is for loads Cristian has
// already bought and is receiving/reconciling. This is for manifests he's
// still deciding on: upload the CSV, run the sourcing agent, and either
// pass (never touch it again) or mark it purchased, which graduates the
// same record into the real Manifests list (see purchased on Manifest in
// prisma/schema.prisma).
export default function AnalyzerPage() {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLost, setShowLost] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    fetch("/api/manifests?purchased=false")
      .then((r) => r.json())
      .then(setCandidates);
  }

  useEffect(load, []);

  async function handleFile(file: File) {
    setError(null);
    const csvContent = await file.text();

    let prefill = title.trim();
    if (!prefill) {
      const supplierGuess = /Pallet ID/.test(csvContent) ? "BStock" : /Total Retail Price/.test(csvContent) ? "Liquidation.com" : null;
      prefill = supplierGuess ? `${supplierGuess} — ${new Date().toLocaleDateString()}` : file.name.replace(/\.csv$/i, "");
    }

    setUploading(true);
    try {
      const res = await fetch("/api/manifests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: prefill, csvContent, purchased: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      setTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <AppShell
      title="Analyzer"
      subtitle="Get a Buy / Don't-Buy call and a max bid on a manifest before you commit. Loads you've already bought live under Manifests."
    >
      <div className="flex flex-col gap-6">
        <Card>
          <SectionHeader
            title="Upload a manifest to evaluate"
            description="BStock and Liquidation.com CSV exports — the format is detected automatically."
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Title" hint="Optional — auto-filled from the file if left blank." className="flex-1">
              <Input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. BStock lot 4471" />
            </Field>
            <Button size="lg" onClick={() => fileInputRef.current?.click()} disabled={uploading} className="sm:mb-6">
              <Upload className="size-5" aria-hidden />
              {uploading ? "Parsing…" : "Choose CSV file"}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
              disabled={uploading}
              className="hidden"
            />
          </div>
          {error && <p className="mt-3 text-sm font-medium text-danger">{error}</p>}
        </Card>

        {candidates === null && <p className="text-sm text-muted-foreground">Loading…</p>}

        {candidates && (() => {
          const active = candidates
            .filter((c) => c.bidStatus === "active")
            .sort((x, y) => (y.bidPlacedAt ?? "").localeCompare(x.bidPlacedAt ?? ""));
          const considering = candidates.filter((c) => c.bidStatus !== "active" && c.bidStatus !== "lost");
          const lost = candidates
            .filter((c) => c.bidStatus === "lost")
            .sort((x, y) => (y.bidClosedAt ?? "").localeCompare(x.bidClosedAt ?? ""));
          return (
            <>
              {active.length > 0 && (
                <section>
                  <SectionHeader title="Active bids" action={<Badge tone="primary">{active.length}</Badge>} />
                  <CandidateList candidates={active} />
                </section>
              )}

              <section>
                <SectionHeader
                  title="Under consideration"
                  action={considering.length > 0 ? <Badge>{considering.length}</Badge> : undefined}
                />
                {considering.length === 0 ? (
                  <Card>
                    <p className="text-sm text-muted-foreground">
                      {candidates.length === 0 ? "Nothing uploaded to evaluate yet." : "Nothing else under consideration."}
                    </p>
                  </Card>
                ) : (
                  <CandidateList candidates={considering} />
                )}
              </section>

              {lost.length > 0 && (
                <section>
                  <button
                    type="button"
                    onClick={() => setShowLost((v) => !v)}
                    aria-expanded={showLost}
                    className="mb-3 flex items-center gap-1.5 text-base font-semibold tracking-tight text-foreground"
                  >
                    Lost bids
                    <Badge>{lost.length}</Badge>
                    <ChevronDown
                      className={cn("size-4 text-muted-foreground transition-transform", showLost && "rotate-180")}
                      aria-hidden
                    />
                  </button>
                  {showLost && <CandidateList candidates={lost} muted />}
                </section>
              )}
            </>
          );
        })()}
      </div>
    </AppShell>
  );
}

function CandidateList({ candidates, muted = false }: { candidates: Candidate[]; muted?: boolean }) {
  return (
    <ul className="flex flex-col gap-2">
      {candidates.map((c) => (
        <li key={c.id}>
          <Link
            href={`/analyzer/${c.id}`}
            className={cn(
              "flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm transition-colors hover:bg-muted active:bg-muted",
              muted && "opacity-75"
            )}
          >
            <span
              className={cn(
                "grid size-10 shrink-0 place-items-center rounded-lg",
                c.bidStatus === "active" ? "bg-primary text-primary-foreground" : "bg-blue-50 text-primary"
              )}
            >
              {c.bidStatus === "active" ? (
                <Gavel className="size-5" aria-hidden />
              ) : (
                <ChartColumn className="size-5" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-foreground">{c.title}</p>
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span>{SUPPLIER_LABELS[c.supplier] ?? c.supplier}</span>
                <span>{c._count.lines} lines</span>
                <span>{new Date(c.createdAt).toLocaleDateString()}</span>
              </p>
              <BidLine candidate={c} />
            </div>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

// One line under each candidate: the bid (if any) against the recommended
// max, or just the recommendation when there's no bid yet.
function BidLine({ candidate: c }: { candidate: Candidate }) {
  const max = c.maxBid != null ? money(c.maxBid) : null;
  if (c.bidStatus === "active" && c.bidAmount != null) {
    const over = c.maxBid != null && c.bidAmount > c.maxBid + 0.005;
    return (
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
        <span className="font-semibold tabular-nums text-foreground">Bid {money(c.bidAmount)}</span>
        {max && (
          <span className={cn("tabular-nums", over ? "font-medium text-warning" : "text-muted-foreground")}>
            {over ? `over the ${max} max` : `max ${max}`}
          </span>
        )}
      </p>
    );
  }
  if (c.bidStatus === "lost") {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        Lost{c.bidAmount != null && <> at {money(c.bidAmount)}</>}
        {c.bidClosedAt && <> · {new Date(c.bidClosedAt).toLocaleDateString()}</>}
      </p>
    );
  }
  if (c.recommendation) {
    return (
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={c.recommendation === "buy" ? "success" : "danger"}>
          {c.recommendation === "buy" ? "Buy" : "Don't buy"}
        </Badge>
        {max && c.recommendation === "buy" && <span className="tabular-nums text-muted-foreground">max {max}</span>}
      </p>
    );
  }
  return null;
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
