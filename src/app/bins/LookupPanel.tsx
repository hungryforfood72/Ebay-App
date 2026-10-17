"use client";

import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import {
  api,
  BannerPanel,
  beep,
  binCounts,
  BinStatusBadge,
  ConfirmEmptyButton,
  describeShelf,
  errorText,
  focusField,
  ItemLine,
  plural,
  PrintToStation,
  ScanStep,
  shelfTone,
  type Banner,
  type BinDetail,
  type BinSummary,
  type ItemRow,
  type LookupResult,
} from "./ui";
import type { ItemLocation } from "@/lib/warehouse/types";
import { useCurrentUser } from "@/components/UserNav";

const FIELD = "lookup-scan";

function lookup(code: string) {
  return api<LookupResult>(`/api/bins/lookup?code=${encodeURIComponent(code)}`);
}

// "Where is this / what's in this?" for any label: an item, a bin, a
// shelf, or a product UPC (older items have no label of their own).
export function LookupPanel({ initialCode }: { initialCode?: string }) {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [loading, setLoading] = useState(Boolean(initialCode));

  // Opened from the Bins list (or a link) with a code already chosen.
  useEffect(() => {
    if (!initialCode) return;
    let cancelled = false;
    lookup(initialCode)
      .then((r) => !cancelled && setResult(r))
      .catch((e) => !cancelled && setBanner({ tone: "danger", title: "Not found", lines: [errorText(e)] }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [initialCode]);

  async function run(code: string, quiet = false) {
    setLoading(true);
    setBanner(null);
    try {
      const r = await lookup(code);
      if (!quiet) beep("ok");
      setResult(r);
    } catch (e) {
      beep("error");
      setResult(null);
      setBanner({ tone: "danger", title: "Not found", lines: [errorText(e)] });
    } finally {
      setLoading(false);
      focusField(FIELD);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ScanStep
        id={FIELD}
        label="Anything"
        prompt="Scan an item, bin, shelf or UPC"
        hint="Item label, bin label, shelf label, or the product's barcode."
        onScan={(code) => run(code)}
      />
      {loading && <p className="text-sm text-muted-foreground">Looking…</p>}
      {banner && <BannerPanel banner={banner} />}
      {result?.kind === "bin" && <BinView detail={result} onOpen={(c) => run(c, true)} onChanged={() => run(result.bin.code, true)} />}
      {result?.kind === "item" && <ItemView item={result.item} location={result.location} notInBins={result.notInBins} onOpen={(c) => run(c, true)} />}
      {result?.kind === "items" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{plural(result.items.length, "listing")} with this UPC:</p>
          {result.items.map((r) => (
            <ItemView key={r.item.id} item={r.item} location={r.location} notInBins={r.notInBins} onOpen={(c) => run(c, true)} />
          ))}
        </div>
      )}
      {result?.kind === "shelf" && (
        <ShelfView result={result} onOpen={(c) => run(c, true)} onChanged={() => run(result.shelf, true)} />
      )}
    </div>
  );
}

function BinButton({ code, onOpen }: { code: string; onOpen: (code: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(code)} className="font-mono font-semibold text-primary hover:underline">
      {code}
    </button>
  );
}

const MOVE_WORDS: Record<string, string> = {
  place: "Put in",
  pick: "Picked",
  sale: "Sold in person",
  pull: "Pulled",
  adjust: "Stock removed",
  transfer: "Moved",
  merge: "Combined",
  shelve: "Shelved",
  unshelve: "Taken off shelf",
};

export function BinView({
  detail,
  onOpen,
  onChanged,
}: {
  detail: BinDetail;
  onOpen: (code: string) => void;
  onChanged: () => void;
}) {
  const { bin, contents, moves } = detail;
  const [showMoves, setShowMoves] = useState(false);
  const [unshelving, setUnshelving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unshelve() {
    setUnshelving(true);
    setError(null);
    try {
      await api("/api/bins/unshelve", { binCode: bin.code });
      beep("ok");
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUnshelving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-3xl font-bold tracking-tight text-foreground">{bin.code}</p>
            <p className="mt-1 text-sm text-muted-foreground">{binCounts(bin)}</p>
          </div>
          <BinStatusBadge bin={bin} />
        </div>
        {bin.shelfLabel && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={unshelve} disabled={unshelving}>
              {unshelving ? "Saving…" : `Take off shelf ${bin.shelfLabel}`}
            </Button>
            {bin.status === "empty" && <span className="text-xs text-muted-foreground">It&apos;s empty: grab it for reuse.</span>}
          </div>
        )}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Card>

      {contents.length > 0 && (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {contents.map((c) => (
              <li key={c.id} className="px-4 py-3">
                <ItemLine
                  item={c}
                  right={<span className="text-base font-semibold text-foreground">×{c.units}</span>}
                  sub={
                    c.status === "expired" ? (
                      <Badge tone="danger" className="mt-1">
                        Pulled: take it out
                      </Badge>
                    ) : undefined
                  }
                />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card padded={false}>
        <button
          type="button"
          onClick={() => setShowMoves((v) => !v)}
          className="flex w-full items-center justify-between gap-2 p-4 text-left text-sm font-medium text-foreground"
        >
          Recent history ({moves.length})
          <ChevronDown className={cn("size-4 transition-transform", showMoves && "rotate-180")} aria-hidden />
        </button>
        {showMoves && (
          <ul className="divide-y divide-border border-t border-border text-sm">
            {moves.length === 0 && <li className="px-4 py-2.5 text-muted-foreground">Nothing yet.</li>}
            {moves.map((m) => (
              <li key={m.id} className="px-4 py-2.5">
                <p className="text-foreground">
                  <span className="font-medium">{MOVE_WORDS[m.kind] ?? m.kind}</span>
                  {m.units != null ? ` ×${m.units}` : ""}
                  {m.itemTitle ? ` · ${m.itemTitle}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {m.fromBinCode && m.fromBinCode !== bin.code ? (
                    <>
                      from <BinButton code={m.fromBinCode} onOpen={onOpen} />{" "}
                    </>
                  ) : null}
                  {m.toBinCode && m.toBinCode !== bin.code ? (
                    <>
                      into <BinButton code={m.toBinCode} onOpen={onOpen} />{" "}
                    </>
                  ) : null}
                  {m.shelfLabel ? `shelf ${m.shelfLabel} ` : ""}
                  {m.note ? `(${m.note}) ` : ""}
                  {m.by ? `by ${m.by} · ` : ""}
                  {new Date(m.createdAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <SectionHeader title="Reprint this bin's label" />
        <PrintToStation
          label="Print"
          onPrint={async (stationId) => {
            await api("/api/bins/print", { stationId, kind: "bin", codes: [bin.code] });
            return `Sent ${bin.code} to the printer.`;
          }}
        />
      </Card>
    </div>
  );
}

export function ItemView({
  item,
  location,
  notInBins,
  onOpen,
}: {
  item: ItemRow;
  location: ItemLocation;
  notInBins: number;
  onOpen: (code: string) => void;
}) {
  return (
    <Card>
      <ItemLine item={item} right={<span className="text-sm text-muted-foreground">{item.available} available</span>} />
      <div className="mt-3 flex flex-col gap-2">
        {item.status === "sold" && <Alert tone="info">Sold out. Any bags here are waiting to be picked.</Alert>}
        {item.status === "expired" && <Alert tone="danger">Pulled for expiry. Take it out of its bin.</Alert>}
        {location.bins.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {location.bins.map((b) => (
              <li key={b.binCode} className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2">
                <span className="text-base">
                  <BinButton code={b.binCode} onOpen={onOpen} />
                  <span className="ml-2 text-foreground">{b.shelfLabel ? `on shelf ${b.shelfLabel}` : "not shelved"}</span>
                </span>
                <span className="text-sm font-semibold text-foreground">×{b.units}</span>
              </li>
            ))}
          </ul>
        ) : location.legacyShelf ? (
          <p className="text-base font-semibold text-foreground">Shelf {location.legacyShelf} (no bin)</p>
        ) : (
          <p className="text-sm text-muted-foreground">Not in a bin yet. Scan it into one on Fill bins.</p>
        )}
        {notInBins > 0 && item.status !== "expired" && location.bins.length > 0 && (
          <p className="text-sm text-warning">
            {plural(notInBins, "unit")} not in any bin. Found {notInBins === 1 ? "it" : "them"}? Use Put away.
          </p>
        )}
      </div>
    </Card>
  );
}

function ShelfView({
  result,
  onOpen,
  onChanged,
}: {
  result: Extract<LookupResult, { kind: "shelf" }>;
  onOpen: (code: string) => void;
  onChanged: () => void;
}) {
  const user = useCurrentUser();
  const [undoError, setUndoError] = useState<string | null>(null);
  const full = result.bins.filter((b) => b.status !== "empty");
  const empty = result.bins.filter((b) => b.status === "empty");
  const { state } = result;

  // Owner only: a confirm made by mistake. The server refuses once bins
  // are on the shelf.
  async function undoConfirm() {
    setUndoError(null);
    try {
      const res = await fetch("/api/bins/shelves/confirm-empty", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shelfLabel: result.shelf }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't undo.");
      onChanged();
    } catch (e) {
      setUndoError(errorText(e));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-3xl font-bold tracking-tight text-foreground">Shelf {result.shelf}</p>
          <Badge tone={shelfTone(state)}>{describeShelf(state)}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {plural(full.length, "bin")}
          {result.legacyCount > 0 ? ` · ${plural(result.legacyCount, "old-system item")} still here` : ""}
        </p>
        {state.state === "old_items" && (
          <p className="mt-2 text-sm text-foreground">Bins can go here once the old items below are gone.</p>
        )}
        {state.state === "looks_empty" && (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-sm text-foreground">
              The records say the old items are gone. An item sold online but not shipped yet can still be sitting here,
              so look before confirming.
            </p>
            <ConfirmEmptyButton shelf={result.shelf} onConfirmed={onChanged} />
          </div>
        )}
        {state.state === "bins" && (
          <p className="mt-2 text-xs text-muted-foreground">
            Confirmed empty{state.binsAllowedBy ? ` by ${state.binsAllowedBy}` : ""}
            {state.binsAllowedAt ? ` on ${new Date(state.binsAllowedAt).toLocaleDateString()}` : ""}.
            {user?.role === "owner" && state.bins === 0 && (
              <button type="button" onClick={undoConfirm} className="ml-2 font-medium text-primary hover:underline">
                Undo
              </button>
            )}
          </p>
        )}
        {state.state === "bins" && state.oldItems > 0 && (
          <p className="mt-1 text-sm text-warning">
            The records show {plural(state.oldItems, "old item")} here again. Check the shelf.
          </p>
        )}
        {undoError && <p className="mt-1 text-sm text-danger">{undoError}</p>}
      </Card>
      {empty.length > 0 && (
        <Alert tone="warning" title="Empty bins still marked here">
          Grab {empty.map((b) => b.code).join(", ")} for reuse (open one and tap Take off shelf).
        </Alert>
      )}
      {full.length > 0 && (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {full.map((b: BinSummary) => (
              <li key={b.code} className="flex items-center justify-between gap-3 px-4 py-3">
                <BinButton code={b.code} onOpen={onOpen} />
                <span className="text-sm text-muted-foreground">{binCounts(b)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {result.legacyItems.length > 0 && (
        <Card padded={false}>
          <SectionHeader
            title="Old-system items still here"
            description="Listed before bins. They stay here until they sell or get pulled."
            className="mb-0 p-4 pb-3"
          />
          <ul className="divide-y divide-border border-t border-border">
            {result.legacyItems.map((r) => (
              <li key={r.item.id} className="px-4 py-3">
                <ItemLine
                  item={r.item}
                  right={
                    <span className="text-sm font-semibold text-foreground">
                      ×{r.item.available}
                      <span className="block text-xs font-normal text-muted-foreground">left</span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
          {result.legacyCount > result.legacyItems.length && (
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              Showing {result.legacyItems.length} of {result.legacyCount}.
            </p>
          )}
        </Card>
      )}
      <Card>
        <SectionHeader title="Reprint this shelf's label" />
        <PrintToStation
          label="Print"
          onPrint={async (stationId) => {
            await api("/api/bins/print", { stationId, kind: "shelf", codes: [result.shelf] });
            return `Sent shelf ${result.shelf} to the printer.`;
          }}
        />
      </Card>
    </div>
  );
}
