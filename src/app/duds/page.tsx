"use client";

import { ScanField } from "@/components/ScanField";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import type { DudBoxSummary } from "@/lib/warehouse/dudBoxTypes";
import { ChevronRight, LoaderCircle, PackageX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { STATUS_TEXT, STATUS_TONE } from "./shared";

// Dud boxes: the boxes sorters filled at the sort station, one load each.
// Whoever processes duds scans a box's label (or taps it here) and decides
// each product: Shopify, not worth Shopify, toss or donate.

type Filter = "todo" | "done" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
];

const FILTER_STATUS: Record<Filter, string> = { todo: "open,closed", done: "done", all: "" };

export default function DudBoxesPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("todo");
  const [boxes, setBoxes] = useState<DudBoxSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const status = FILTER_STATUS[filter];
    fetch(`/api/dud-boxes${status ? `?status=${status}` : ""}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error ?? "Couldn't load the dud boxes.");
        return data.boxes as DudBoxSummary[];
      })
      .then((list) => {
        if (cancelled) return;
        setBoxes(list);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load the dud boxes."));
    return () => {
      cancelled = true;
    };
  }, [filter]);

  function handleScan() {
    const raw = code.trim();
    setCode("");
    if (!raw) return;
    if (classifyScan(raw) !== "dudbox") {
      setScanError("That isn't a dud box label. Those start with DB.");
      return;
    }
    setScanError(null);
    router.push(`/duds/${normalizeCode(raw)}`);
  }

  return (
    <AppShell width="medium" title="Dud boxes" subtitle="Scan a dud box to decide what happens to each product in it.">
      <div className="flex flex-col gap-4">
        <Card>
          <ScanField
            id="duds-scan"
            label="Dud box"
            prompt="Scan the dud box label"
            autoFocus
            value={code}
            onChange={setCode}
            onScan={handleScan}
          />
          {scanError && <p className="mt-2 text-sm text-danger">{scanError}</p>}
        </Card>

        <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => {
                setFilter(f.key);
                setBoxes(null);
              }}
              className={cn(
                "h-10 flex-1 rounded-md text-sm font-medium transition-colors",
                filter === f.key
                  ? "bg-surface text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && <Alert tone="danger">{error}</Alert>}
        {!error && boxes === null && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Loading…
          </p>
        )}
        {boxes && boxes.length === 0 && (
          <Card>
            <p className="text-sm text-muted-foreground">
              {filter === "todo"
                ? "No dud boxes to do. Sorters start them on the Sort page."
                : filter === "done"
                  ? "No finished dud boxes yet."
                  : "No dud boxes yet. Sorters start them on the Sort page."}
            </p>
          </Card>
        )}
        {boxes && boxes.length > 0 && (
          <ul className="flex flex-col gap-2">
            {boxes.map((b) => (
              <li key={b.code}>
                <Link
                  href={`/duds/${b.code}`}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left shadow-sm transition-colors hover:bg-muted active:bg-muted"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700">
                    <PackageX className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-base font-bold text-foreground">{b.code}</span>
                      <Badge tone={STATUS_TONE[b.status]}>{STATUS_TEXT[b.status]}</Badge>
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-foreground">{b.manifestTitle}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{summaryLine(b)}</span>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

// "12 units · 3 to decide · listed 2 of 4 for Shopify"
function summaryLine(b: DudBoxSummary): string {
  if (b.entryCount === 0) return "Empty";
  const parts = [`${b.units} ${b.units === 1 ? "unit" : "units"}`];
  if (b.undecided > 0) parts.push(`${b.undecided} to decide`);
  if (b.shopifyUnits > 0) parts.push(`listed ${b.listedUnits} of ${b.shopifyUnits} for Shopify`);
  return parts.join(" · ");
}
