"use client";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import { ArrowDown, Check } from "lucide-react";
import { useState } from "react";
import {
  api,
  BannerPanel,
  beep,
  binCounts,
  binName,
  BinStatusBadge,
  errorText,
  focusField,
  ItemLine,
  plural,
  ScanStep,
  type Banner,
  type BinDetail,
  type BinSummary,
} from "./ui";

const FIELD = "combine-scan";

type MoveResult = { itemsMoved: number; unitsMoved: number; fromEmpty: boolean; from: BinSummary | null; to: BinSummary | null };

// Combining bins so half-empty ones don't pile up:
//   1. scan the bin to take from
//   2. either scan the bin to move into right away (moves everything), or
//      first scan the item labels to move only those, then the bin
//   3. check what will move, confirm
// Either bin can be an oversized shelf (scan the shelf's own label): a
// bin's items go onto the shelf, or come off it into a bin.
// Nothing moves until the confirm tap. The counts after are what really
// moved, in case someone picked from the bin in the meantime.
export function CombinePanel() {
  const [from, setFrom] = useState<BinDetail | null>(null);
  const [to, setTo] = useState<BinDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<Banner | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  function reset() {
    setFrom(null);
    setTo(null);
    setSelected(new Set());
    focusField(FIELD);
  }

  function fail(title: string, line?: string) {
    beep("error");
    setBanner({ tone: "danger", title, lines: line ? [line] : [] });
    focusField(FIELD);
  }

  async function loadBin(code: string): Promise<BinDetail | null> {
    setLoading(true);
    try {
      return await api<BinDetail>(`/api/bins/${encodeURIComponent(code)}`);
    } catch (e) {
      fail("Couldn't find that bin or shelf", errorText(e));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleScan(raw: string) {
    const code = normalizeCode(raw);
    const kind = classifyScan(code);
    if (to) return; // On the confirm step: confirm or go back first.

    // "other" is usually a shelf label: an oversized shelf counts as a bin
    // here (the server says if it's a bin shelf).
    const binLike = kind === "bin" || kind === "other";

    if (!from) {
      if (!binLike) return fail("Scan a bin label", "Start with the bin (or oversized shelf) you're taking items out of.");
      const bin = await loadBin(raw);
      if (!bin) return;
      if (bin.contents.length === 0) return fail(`${binName(bin.bin)} is already empty`, "Scan one that has items in it.");
      beep("next");
      setBanner(null);
      setFrom(bin);
      focusField(FIELD);
      return;
    }

    if (binLike) {
      if (code === from.bin.code) return fail("That's the same bin", "Scan the bin you're moving items into.");
      const bin = await loadBin(raw);
      if (!bin) return;
      if (bin.bin.code === from.bin.code) return fail("That's the same shelf", "Scan the bin you're moving items into.");
      beep("next");
      setBanner(null);
      setTo(bin);
      return;
    }

    // An item to move on its own: its label, or the UPC for an older item
    // that has no label.
    const matches = from.contents.filter((c) => c.code.toUpperCase() === code || c.upc === code);
    if (matches.length === 0) return fail(`Not in ${binName(from.bin)}`, `${code} isn't ${from.bin.oversizedShelf ? "on this shelf" : "in this bin"}.`);
    if (matches.length > 1) return fail("More than one match", "Several items here share that UPC. Tap the right one below.");
    const id = matches[0].id;
    beep("next");
    setBanner(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    focusField(FIELD);
  }

  // Taps send focus back to the scan field: a scan landing on a focused
  // button would "press" it with the scanner's Enter.
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    focusField(FIELD);
  }

  // Nothing picked (or everything picked) = empty the whole bin.
  const moveAll = from != null && (selected.size === 0 || selected.size === from.contents.length);
  const moving = from ? (moveAll ? from.contents : from.contents.filter((c) => selected.has(c.id))) : [];
  const movingUnits = moving.reduce((sum, c) => sum + c.units, 0);

  async function confirm() {
    if (!from || !to) return;
    setSaving(true);
    try {
      const res = moveAll
        ? await api<MoveResult>("/api/bins/merge", { fromBinCode: from.bin.code, toBinCode: to.bin.code })
        : await api<MoveResult>("/api/bins/transfer", {
            fromBinCode: from.bin.code,
            toBinCode: to.bin.code,
            itemIds: moving.map((c) => c.id),
          });
      beep("ok");
      setBanner({
        tone: "success",
        title: res.fromEmpty
          ? from.bin.oversizedShelf
            ? `${binName(from.bin)} is clear`
            : `${from.bin.code} is empty`
          : `Moved ${to.bin.oversizedShelf ? "onto" : "into"} ${binName(to.bin)}`,
        lines: [
          `${plural(res.unitsMoved, "unit")} (${plural(res.itemsMoved, "item")}) now ${
            to.bin.oversizedShelf
              ? `on oversized shelf ${to.bin.oversizedShelf}`
              : `in ${to.bin.code}${res.to?.shelfLabel ? ` on shelf ${res.to.shelfLabel}` : ""}`
          }.`,
          res.unitsMoved !== movingUnits
            ? `That's ${movingUnits - res.unitsMoved > 0 ? "fewer" : "more"} than shown: someone changed the bin while you were moving it.`
            : "",
          res.fromEmpty
            ? from.bin.oversizedShelf
              ? ""
              : `Put ${from.bin.code} with the empty bins for reuse.`
            : res.from
              ? `${binName(from.bin)} still has ${binCounts(res.from).toLowerCase()}.`
              : "",
        ],
      });
      reset();
    } catch (e) {
      fail("Nothing moved", errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!to && (
        <ScanStep
          id={FIELD}
          label={!from ? "Bin to take from" : "Items to move, or the bin to move into"}
          prompt={!from ? "Scan the bin you're emptying" : moveAll ? "Scan the bin to move everything into" : "Scan more items, or the bin to move into"}
          hint={
            from
              ? "Scan item labels to move only some. Scan the other bin (or an oversized shelf's label) when you're ready."
              : "Then scan the bin it's going into. Oversized shelves work too: scan the shelf's label."
          }
          onScan={handleScan}
          disabled={loading}
        />
      )}

      {banner && <BannerPanel banner={banner} />}

      {from && !to && (
        <Card padded={false}>
          <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-3">
            <div>
              <p className="font-mono text-lg font-semibold text-foreground">{binName(from.bin)}</p>
              <p className="text-sm text-muted-foreground">{binCounts(from.bin)}</p>
            </div>
            <div className="flex items-center gap-2">
              {!from.bin.oversizedShelf && <BinStatusBadge bin={from.bin} />}
              <Button variant="ghost" size="sm" onClick={reset}>
                Start over
              </Button>
            </div>
          </div>
          <p className="border-t border-border bg-muted/50 px-4 py-2 text-sm font-medium text-foreground">
            {moveAll ? "Moving everything" : `Moving ${plural(selected.size, "item")} (${plural(movingUnits, "unit")})`}
            {!moveAll && (
              <button
                type="button"
                className="ml-2 text-primary hover:underline"
                onClick={() => {
                  setSelected(new Set());
                  focusField(FIELD);
                }}
              >
                Move everything instead
              </button>
            )}
          </p>
          <ul className="divide-y divide-border border-t border-border">
            {from.contents.map((c) => {
              const on = selected.has(c.id);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => toggle(c.id)}
                    className={cn("flex w-full items-center gap-3 px-4 py-3 text-left", on && "bg-blue-50/70")}
                  >
                    <span
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-md border",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface"
                      )}
                      aria-hidden
                    >
                      {on && <Check className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <ItemLine item={c} right={<span className="text-sm font-semibold text-foreground">×{c.units}</span>} />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {from && to && (
        <Card>
          <p className="text-sm font-medium text-muted-foreground">Check, then confirm</p>
          <div className="mt-3 flex flex-col items-stretch gap-2">
            <div className="rounded-lg border border-border p-3">
              <p className="font-mono text-xl font-semibold text-foreground">{binName(from.bin)}</p>
              <p className="text-sm text-muted-foreground">
                {moveAll ? `All ${plural(movingUnits, "unit")} (${plural(moving.length, "item")})` : `${plural(moving.length, "item")}, ${plural(movingUnits, "unit")}`}
              </p>
            </div>
            <ArrowDown className="mx-auto size-6 text-muted-foreground" aria-hidden />
            <div className="rounded-lg border border-border p-3">
              <p className="font-mono text-xl font-semibold text-foreground">{binName(to.bin)}</p>
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {to.bin.oversizedShelf ? `Oversized shelf, ${binCounts(to.bin).toLowerCase()} on it now` : <>{binCounts(to.bin)} now <BinStatusBadge bin={to.bin} /></>}
              </p>
            </div>
          </div>
          {!moveAll && (
            <ul className="mt-3 flex flex-col gap-1 text-sm text-foreground">
              {moving.map((c) => (
                <li key={c.id} className="truncate">
                  ×{c.units} {c.title}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <Button size="xl" block onClick={confirm} disabled={saving}>
              {saving ? "Moving…" : `Move ${plural(movingUnits, "unit")} ${to.bin.oversizedShelf ? "onto" : "into"} ${binName(to.bin)}`}
            </Button>
            <Button
              variant="ghost"
              block
              onClick={() => {
                setTo(null);
                focusField(FIELD);
              }}
              disabled={saving}
            >
              Back
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
