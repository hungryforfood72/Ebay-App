"use client";

import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { ChevronRight, FileSpreadsheet, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Manifest = {
  id: string;
  title: string;
  supplier: string;
  totalLandedCost?: string | null;
  createdAt: string;
  _count: { lines: number; items: number };
};

const SUPPLIER_LABELS: Record<string, string> = {
  bstock: "BStock",
  liquidation_com: "Liquidation.com",
  unknown: "Unknown",
};

export default function ManifestsPage() {
  const [manifests, setManifests] = useState<Manifest[] | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    fetch("/api/manifests")
      .then((r) => r.json())
      .then(setManifests);
  }

  useEffect(load, []);

  async function handleFile(file: File) {
    setError(null);
    const csvContent = await file.text();

    // Detected supplier prefills a reasonable title, but only if the user
    // hasn't already typed their own.
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
        body: JSON.stringify({ title: prefill, csvContent }),
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
    <AppShell title="Manifests" subtitle="Upload a supplier manifest, then scan against it to reconcile what arrived.">
      <div className="flex flex-col gap-6">
        <Card>
          <SectionHeader
            title="Upload a new manifest"
            description="BStock and Liquidation.com CSV exports — the format is detected automatically."
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Title" hint="Optional — auto-filled from the file if left blank." className="flex-1">
              <Input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. BStock pallet 9/24" />
            </Field>
            <Button
              size="lg"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="sm:mb-6"
            >
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

        <section>
          <SectionHeader
            title="All manifests"
            action={manifests && manifests.length > 0 ? <Badge>{manifests.length}</Badge> : undefined}
          />
          {manifests === null && <p className="text-sm text-muted-foreground">Loading…</p>}

          {manifests && manifests.length === 0 && (
            <Card>
              <p className="text-sm text-muted-foreground">No manifests uploaded yet.</p>
            </Card>
          )}

          {manifests && manifests.length > 0 && (
            <ul className="flex flex-col gap-2">
              {manifests.map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/manifests/${m.id}`}
                    className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm transition-colors hover:bg-muted active:bg-muted"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-50 text-primary">
                      <FileSpreadsheet className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{m.title}</p>
                      <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                        <span>{SUPPLIER_LABELS[m.supplier] ?? m.supplier}</span>
                        <span>{m._count.lines} lines</span>
                        <span>{m._count.items} scanned in</span>
                        <span>{new Date(m.createdAt).toLocaleDateString()}</span>
                      </p>
                    </div>
                    {m.totalLandedCost && (
                      <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
                        ${Number(m.totalLandedCost).toFixed(2)}
                      </span>
                    )}
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
