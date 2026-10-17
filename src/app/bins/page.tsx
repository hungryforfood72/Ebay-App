"use client";

import { useCurrentUser } from "@/components/UserNav";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { cn } from "@/components/ui/cn";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { CombinePanel } from "./CombinePanel";
import { FillPanel } from "./FillPanel";
import { LookupPanel } from "./LookupPanel";
import { OverviewPanel } from "./OverviewPanel";
import { PutAwayPanel } from "./PutAwayPanel";
import { ShelvePanel } from "./ShelvePanel";
import type { BinSummary, ShelfState } from "./ui";

type Tab = "fill" | "shelve" | "combine" | "lookup" | "putaway" | "overview";

const TABS: { value: Tab; label: string }[] = [
  { value: "fill", label: "Fill bins" },
  { value: "shelve", label: "Shelve" },
  { value: "combine", label: "Combine" },
  { value: "lookup", label: "Look up" },
  { value: "putaway", label: "Put away" },
  { value: "overview", label: "Bins" },
];

export default function BinsPage() {
  return (
    <Suspense>
      <BinsPageInner />
    </Suspense>
  );
}

// Warehouse mode's bin work on the handheld: filling bins at the binning
// station (the default tab), shelving closed bins, combining
// half-empty ones, finding anything, putting stray units away, and the
// overview of every bin. ?tab=putaway&item=ES000123 (the Inventory page's
// link) and ?tab=lookup&code=BN0001 open straight to that.
function BinsPageInner() {
  const searchParams = useSearchParams();
  const user = useCurrentUser();
  const initialTab = TABS.some((t) => t.value === searchParams.get("tab")) ? (searchParams.get("tab") as Tab) : "fill";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [bins, setBins] = useState<BinSummary[] | null>(null);
  const [shelves, setShelves] = useState<string[]>([]);
  const [pendingRemovals, setPendingRemovals] = useState(0);
  const [shelfStates, setShelfStates] = useState<ShelfState[]>([]);
  const [warehouseOn, setWarehouseOn] = useState(true);
  // Listings with labeled units not in a bin yet (badge on Fill bins).
  const [waitingCount, setWaitingCount] = useState<number | null>(null);
  // Bumped to open Look up on a bin picked from the overview (remounts it).
  const [lookupCode, setLookupCode] = useState<{ code: string; n: number } | null>(
    searchParams.get("code") ? { code: searchParams.get("code")!, n: 0 } : null
  );

  const loadBins = useCallback(() => {
    fetch("/api/bins")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { bins: BinSummary[]; shelves: string[]; pendingRemovals?: number; shelfStates?: ShelfState[] } | null) => {
        if (!data) return;
        setShelfStates(data.shelfStates ?? []);
        setBins(data.bins);
        setShelves(data.shelves);
        setPendingRemovals(data.pendingRemovals ?? 0);
      })
      .catch(() => {
        // The overview shows "Loading" until a later refresh works.
      });
  }, []);

  useEffect(() => {
    loadBins();
    fetch("/api/bins/fill")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count?: number } | null) => d?.count != null && setWaitingCount(d.count))
      .catch(() => {});
    fetch("/api/warehouse/mode")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setWarehouseOn(d?.on !== false))
      .catch(() => {});
  }, [loadBins]);

  function switchTab(next: Tab) {
    setTab(next);
    // Other people shelve and pick too, so the overview re-reads each time.
    if (next === "overview" || next === "shelve") loadBins();
  }

  return (
    <AppShell title="Bins" width="narrow">
      <div className="flex flex-col gap-4">
        {!warehouseOn && (
          <Alert tone="info">Warehouse mode is off in Settings. Bins still work here, but new scans won&apos;t use them.</Alert>
        )}
        <div className="-mx-4 overflow-x-auto px-4">
          <div className="inline-flex min-w-full gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="Bin tasks">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={tab === t.value}
                onClick={() => switchTab(t.value)}
                className={cn(
                  "h-10 flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors",
                  tab === t.value ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
                {t.value === "fill" && waitingCount ? (
                  <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800">
                    {waitingCount}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {tab === "fill" && <FillPanel onWaitingCount={setWaitingCount} />}
        {tab === "shelve" && <ShelvePanel bins={bins} onShelved={loadBins} />}
        {tab === "combine" && <CombinePanel />}
        {tab === "lookup" && <LookupPanel key={lookupCode ? `${lookupCode.code}-${lookupCode.n}` : "none"} initialCode={lookupCode?.code} />}
        {tab === "putaway" && <PutAwayPanel initialItemCode={searchParams.get("item") ?? undefined} />}
        {tab === "overview" && (
          <OverviewPanel
            bins={bins}
            shelves={shelves}
            pendingRemovals={pendingRemovals}
            shelfStates={shelfStates}
            isOwner={user?.role === "owner"}
            onChanged={loadBins}
            onOpenBin={(code) => {
              setLookupCode((prev) => ({ code, n: (prev?.n ?? 0) + 1 }));
              setTab("lookup");
            }}
          />
        )}
      </div>
    </AppShell>
  );
}
