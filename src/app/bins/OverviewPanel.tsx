"use client";

import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Field, Input, Select } from "@/components/ui/Input";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import {
  api,
  binCounts,
  BinStatusBadge,
  ConfirmEmptyButton,
  describeShelf,
  errorText,
  plural,
  PrintToStation,
  shelfTone,
  type BinSummary,
  type ShelfState,
} from "./ui";

// A bin on a shelf with this many units or fewer counts as "low". Two or
// more low bins on the same shelf get a suggestion to combine them into
// the fullest of them, which frees the rest up for reuse. Same shelf only,
// so it's one trip, and units rather than items because units are what
// take up the room. Kept deliberately simple; tune the number if the
// suggestions are too eager or too shy.
const LOW_UNITS = 5;

type Filter = "all" | "empty" | "filling" | "ready" | "shelved";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "empty", label: "Empty" },
  { value: "filling", label: "Open" },
  { value: "ready", label: "Ready to shelve" },
  { value: "shelved", label: "On a shelf" },
];

const PAGE = 150;

export function OverviewPanel({
  bins,
  shelves,
  pendingRemovals,
  shelfStates,
  isOwner,
  onOpenBin,
  onChanged,
}: {
  bins: BinSummary[] | null;
  shelves: string[];
  // Sales/pulls whose bin count couldn't be updated yet (see
  // removeUnitsBestEffort). Retried every time this page loads.
  pendingRemovals: number;
  shelfStates: ShelfState[];
  isOwner: boolean;
  onOpenBin: (code: string) => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [shelfFilter, setShelfFilter] = useState("");
  const [shown, setShown] = useState(PAGE);

  const grabForReuse = useMemo(() => (bins ?? []).filter((b) => b.status === "empty" && b.shelfLabel), [bins]);

  const suggestions = useMemo(() => {
    const byShelf = new Map<string, BinSummary[]>();
    for (const b of bins ?? []) {
      if (b.status !== "shelved" || b.units > LOW_UNITS) continue;
      byShelf.set(b.shelfLabel!, [...(byShelf.get(b.shelfLabel!) ?? []), b]);
    }
    return [...byShelf.entries()]
      .filter(([, list]) => list.length >= 2)
      .map(([shelf, list]) => {
        const sorted = [...list].sort((a, b) => b.units - a.units);
        return { shelf, keep: sorted[0], empty: sorted.slice(1) };
      })
      .sort((a, b) => a.shelf.localeCompare(b.shelf, undefined, { numeric: true }));
  }, [bins]);

  const filtered = useMemo(
    () =>
      (bins ?? []).filter(
        (b) => (filter === "all" || b.status === filter) && (!shelfFilter || b.shelfLabel === shelfFilter)
      ),
    [bins, filter, shelfFilter]
  );

  const counts = useMemo(() => {
    const c = { all: 0, empty: 0, filling: 0, ready: 0, shelved: 0 };
    for (const b of bins ?? []) {
      c.all++;
      c[b.status]++;
    }
    return c;
  }, [bins]);

  if (!bins) return <p className="text-sm text-muted-foreground">Loading bins…</p>;

  return (
    <div className="flex flex-col gap-4">
      {pendingRemovals > 0 && (
        <Alert tone="warning" title={`Bin counts catching up (${pendingRemovals})`}>
          {plural(pendingRemovals, "sale or pull", "sales or pulls")} couldn&apos;t update the bins at the time (they were busy).
          The sales are saved. The bins get fixed automatically; reopen this page to retry now.
        </Alert>
      )}
      {grabForReuse.length > 0 && (
        <Alert tone="warning" title={`Empty bins still on a shelf (${grabForReuse.length})`}>
          <p>Go grab these for reuse, then tap one to take it off its shelf.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {grabForReuse.map((b) => (
              <button
                key={b.code}
                type="button"
                onClick={() => onOpenBin(b.code)}
                className="rounded-md border border-amber-300 bg-surface px-2 py-1 font-mono text-sm text-foreground"
              >
                {b.code} · {b.shelfLabel}
              </button>
            ))}
          </div>
        </Alert>
      )}

      {suggestions.length > 0 && (
        <Card>
          <SectionHeader
            title="Could be combined"
            description={`Bins on the same shelf with ${LOW_UNITS} units or fewer. Use Combine to empty the smaller ones into the fullest.`}
          />
          <ul className="flex flex-col gap-2 text-sm">
            {suggestions.map((s) => (
              <li key={s.shelf} className="rounded-lg bg-muted/60 px-3 py-2">
                <span className="font-semibold text-foreground">Shelf {s.shelf}:</span>{" "}
                {s.empty.map((b, i) => (
                  <span key={b.code}>
                    {i > 0 ? ", " : ""}
                    <BinLink bin={b} onOpen={onOpenBin} />
                  </span>
                ))}{" "}
                into <BinLink bin={s.keep} onOpen={onOpenBin} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ShelvesCard shelfStates={shelfStates} isOwner={isOwner} onOpen={onOpenBin} onChanged={onChanged} />

      <Card padded={false}>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={filter === f.value}
                onClick={() => {
                  setFilter(f.value);
                  setShown(PAGE);
                }}
                className={cn(
                  "h-9 rounded-full border px-3 text-sm font-medium transition-colors",
                  filter === f.value ? "border-primary bg-blue-50 text-primary" : "border-border bg-surface text-muted-foreground"
                )}
              >
                {f.label} ({counts[f.value]})
              </button>
            ))}
          </div>
          <Select
            size="sm"
            value={shelfFilter}
            onChange={(e) => {
              setShelfFilter(e.target.value);
              setShown(PAGE);
            }}
            aria-label="Shelf"
          >
            <option value="">Every shelf</option>
            {shelves.map((s) => (
              <option key={s} value={s}>
                Shelf {s}
              </option>
            ))}
          </Select>
        </div>
        {filtered.length === 0 ? (
          <p className="border-t border-border p-4 text-sm text-muted-foreground">
            {bins.length === 0 ? "No bins yet." : "No bins match."}
          </p>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {filtered.slice(0, shown).map((b) => (
              <li key={b.code}>
                <button
                  type="button"
                  onClick={() => onOpenBin(b.code)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted"
                >
                  <span className="font-mono font-semibold text-foreground">{b.code}</span>
                  <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                    <span className="truncate">{binCounts(b)}</span>
                    <BinStatusBadge bin={b} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {filtered.length > shown && (
          <div className="border-t border-border p-3 text-center">
            <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({filtered.length - shown} left)
            </Button>
          </div>
        )}
      </Card>

      {isOwner && <OwnerTools bins={bins} shelves={shelves} onChanged={onChanged} />}
    </div>
  );
}

// Warehouse cutover: which shelves take bins yet. A shelf moves to bins
// once its old-system items are gone and someone confirms it's empty.
// The owner can make a shelf oversized (Cristian, 2026-10-24): no bins,
// big items sit straight on it.
function ShelvesCard({
  shelfStates,
  isOwner,
  onOpen,
  onChanged,
}: {
  shelfStates: ShelfState[];
  isOwner: boolean;
  onOpen: (code: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busyShelf, setBusyShelf] = useState<string | null>(null);
  const [shelfError, setShelfError] = useState<{ shelf: string; text: string } | null>(null);
  if (shelfStates.length === 0) return null;
  const oversized = shelfStates.filter((s) => s.oversized).length;
  const onBins = shelfStates.filter((s) => !s.oversized && (s.state === "free" || s.state === "bins")).length;
  const toConfirm = shelfStates.filter((s) => !s.oversized && s.state === "looks_empty");
  const oldSystem = shelfStates.length - onBins - oversized;

  async function setOversized(s: ShelfState, on: boolean) {
    setBusyShelf(s.label);
    setShelfError(null);
    try {
      await api("/api/bins/shelves/oversized", { shelfLabel: s.label, on });
      onChanged();
    } catch (e) {
      setShelfError({ shelf: s.label, text: errorText(e) });
    } finally {
      setBusyShelf(null);
    }
  }
  return (
    <Card padded={false}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold tracking-tight text-foreground">Shelves</span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {plural(onBins, "shelf", "shelves")} on bins
            {oversized > 0 ? `, ${oversized} oversized` : ""}, {oldSystem} still old system
            {toConfirm.length > 0 ? `, ${toConfirm.length} to confirm empty` : ""}
          </span>
        </span>
        <ChevronDown className={cn("mt-1 size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <ul className="divide-y divide-border border-t border-border">
          {shelfStates.map((s) => (
            <li key={s.label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <button type="button" onClick={() => onOpen(s.label)} className="font-semibold text-primary hover:underline">
                {s.label}
              </button>
              <span className="flex items-center gap-2">
                <Badge tone={shelfTone(s)}>{describeShelf(s)}</Badge>
                {isOwner && (s.oversized || s.bins === 0) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOversized(s, !s.oversized)}
                    disabled={busyShelf != null}
                  >
                    {busyShelf === s.label ? "Saving…" : s.oversized ? "Make it a bin shelf" : "Make oversized"}
                  </Button>
                )}
              </span>
              {shelfError?.shelf === s.label && <p className="w-full text-sm text-danger">{shelfError.text}</p>}
              {!s.oversized && s.state === "looks_empty" && (
                <div className="w-full">
                  <ConfirmEmptyButton shelf={s.label} size="md" onConfirmed={onChanged} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BinLink({ bin, onOpen }: { bin: BinSummary; onOpen: (code: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(bin.code)} className="font-mono text-primary hover:underline">
      {bin.code} ({plural(bin.units, "unit")})
    </button>
  );
}

// Owner only: making new bin numbers and printing bin or shelf labels.
function OwnerTools({ bins, shelves, onChanged }: { bins: BinSummary[]; shelves: string[]; onChanged: () => void }) {
  const [count, setCount] = useState("20");
  const [making, setMaking] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const [makeError, setMakeError] = useState<string | null>(null);

  const [kind, setKind] = useState<"bin" | "shelf">("bin");
  const lastBin = bins.length ? bins[bins.length - 1].code : "";
  const [fromCode, setFromCode] = useState(bins[0]?.code ?? "");
  const [toCode, setToCode] = useState(lastBin);
  const [pickedShelves, setPickedShelves] = useState<Set<string>>(new Set());
  const [copies, setCopies] = useState("1");

  async function makeBins() {
    setMaking(true);
    setMakeError(null);
    setMade(null);
    try {
      const { codes } = await api<{ codes: string[] }>("/api/bins", { count: Number(count) });
      setMade(codes.length === 1 ? `Made ${codes[0]}.` : `Made ${codes.length} bins: ${codes[0]} to ${codes[codes.length - 1]}.`);
      // Ready to print the new ones.
      setKind("bin");
      setFromCode(codes[0]);
      setToCode(codes[codes.length - 1]);
      onChanged();
    } catch (e) {
      setMakeError(errorText(e));
    } finally {
      setMaking(false);
    }
  }

  function toggleShelf(label: string) {
    setPickedShelves((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <>
      <Card>
        <SectionHeader title="Make bins" description="Adds new bin numbers after the highest one. Then print their labels below." />
        <div className="flex items-end gap-2">
          <Field label="How many" className="w-28">
            <Input type="number" min={1} max={500} value={count} onChange={(e) => setCount(e.target.value)} />
          </Field>
          <Button onClick={makeBins} disabled={making}>
            {making ? "Making…" : "Make bins"}
          </Button>
        </div>
        {made && <p className="mt-2 text-sm text-success">{made}</p>}
        {makeError && <p className="mt-2 text-sm text-danger">{makeError}</p>}
      </Card>

      <Card>
        <SectionHeader title="Print labels" description="Prints on the station PC's label printer." />
        <div className="flex flex-col gap-3">
          <div className="inline-flex w-fit rounded-lg bg-muted p-1" role="group" aria-label="Label type">
            {(["bin", "shelf"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  "h-9 rounded-md px-3 text-sm font-medium transition-colors",
                  kind === k ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {k === "bin" ? "Bin labels" : "Shelf labels"}
              </button>
            ))}
          </div>

          {kind === "bin" ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="From" className="w-32">
                <Input value={fromCode} onChange={(e) => setFromCode(e.target.value)} placeholder="BN0001" />
              </Field>
              <Field label="To" className="w-32">
                <Input value={toCode} onChange={(e) => setToCode(e.target.value)} placeholder="BN0050" />
              </Field>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="font-medium text-foreground">
                  {pickedShelves.size === 0 ? "Every shelf" : plural(pickedShelves.size, "shelf", "shelves")}
                </span>
                {pickedShelves.size > 0 && (
                  <button type="button" className="text-primary hover:underline" onClick={() => setPickedShelves(new Set())}>
                    Every shelf
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {shelves.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={pickedShelves.has(s)}
                    onClick={() => toggleShelf(s)}
                    className={cn(
                      "h-8 min-w-10 rounded-md border px-2 text-sm",
                      pickedShelves.has(s) ? "border-primary bg-blue-50 text-primary" : "border-border bg-surface text-foreground"
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {shelves.length === 0 && <p className="text-sm text-muted-foreground">No shelves yet. Add them in Settings.</p>}
            </div>
          )}

          <Field label="Copies of each" className="w-28">
            <Input type="number" min={1} max={20} value={copies} onChange={(e) => setCopies(e.target.value)} />
          </Field>

          <PrintToStation
            label="Print"
            onPrint={async (stationId) => {
              const body =
                kind === "bin"
                  ? { stationId, kind, fromCode, toCode, copies: Number(copies) }
                  : pickedShelves.size === 0
                    ? { stationId, kind, allShelves: true, copies: Number(copies) }
                    : { stationId, kind, codes: [...pickedShelves], copies: Number(copies) };
              const res = await api<{ queued: number }>("/api/bins/print", body);
              return `Sent ${plural(res.queued, "label")} to the printer.`;
            }}
          />
        </div>
      </Card>
    </>
  );
}
