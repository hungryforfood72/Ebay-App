"use client";

import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Card, SectionHeader } from "@/components/ui/Card";
import { ChevronRight, FileSpreadsheet } from "lucide-react";
import { ManifestUpload } from "@/components/ManifestUpload";
import { useCurrentUser } from "@/components/UserNav";
import Link from "next/link";
import { useEffect, useState } from "react";

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
  unknown: "Other supplier",
};

export default function ManifestsPage() {
  // Uploading is owner only (the API enforces it too); employees just pick
  // a manifest to scan against.
  const isOwner = useCurrentUser()?.role === "owner";
  const [manifests, setManifests] = useState<Manifest[] | null>(null);

  function load() {
    fetch("/api/manifests")
      .then((r) => r.json())
      .then(setManifests);
  }

  useEffect(load, []);

  return (
    <AppShell
      title="Manifests"
      subtitle={
        isOwner
          ? "Upload a supplier manifest, then scan against it to reconcile what arrived."
          : "Pick a manifest to see what arrived and what's left to scan."
      }
    >
      <div className="flex flex-col gap-6">
        {isOwner && (
          <ManifestUpload
            purchased
            title="Upload a new manifest"
            titlePlaceholder="e.g. BStock pallet 9/24"
            onUploaded={load}
          />
        )}

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
