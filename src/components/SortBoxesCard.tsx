"use client";

import { boxShortName } from "@/lib/warehouse/codes";
import type { SortLocation } from "@/lib/warehouse/sortBoxes";
import { useState } from "react";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";

// Where this product's units were in the sort boxes, so the lister (or
// the lister's helper on /gather) can grab them all at once. "Left some
// here" fixes a box's count when not every unit got taken out. "Count was
// off" is for a box that really held more or fewer than the sort said
// (recorded against the sorter, src/lib/warehouse/sortBoxes.ts fixBoxCount).
// Used by the List page and /gather; headline={false} when the page shows
// its own.
export function SortBoxesCard({
  pull,
  onPutBack,
  onFixCount,
  headline = true,
}: {
  pull: { pulled: { boxCode: string; units: number }[]; locations: SortLocation[] };
  onPutBack: (boxCode: string, units: number) => Promise<string | null>;
  onFixCount: (boxCode: string, found: number) => Promise<string | null>;
  headline?: boolean;
}) {
  const [openBox, setOpenBox] = useState<{ code: string; mode: "back" | "count" } | null>(null);
  const [units, setUnits] = useState("1");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (pull.locations.length === 0) {
    return <p className="text-xs text-muted-foreground">Not sorted into boxes.</p>;
  }
  const total = pull.pulled.reduce((sum, p) => sum + p.units, 0);
  const pulledBefore = pull.locations.reduce((sum, l) => sum + l.pulled, 0);
  const pulledBoxes = pull.locations.filter((l) => l.pulled > 0);
  const gatheredBy = pull.locations.find((l) => l.pulled > 0 && l.gatheredBy)?.gatheredBy ?? null;

  function open(code: string, mode: "back" | "count", start: number) {
    const same = openBox?.code === code && openBox.mode === mode;
    setOpenBox(same ? null : { code, mode });
    setUnits(String(start));
    setNote(null);
  }

  async function save(loc: SortLocation, mode: "back" | "count") {
    const n = Number(units);
    const name = boxShortName(loc.boxCode);
    if (mode === "back") {
      if (!Number.isInteger(n) || n < 1) return setNote("Enter how many are still in the box.");
    } else {
      if (!Number.isInteger(n) || n < 0) return setNote(`Enter how many were really in ${name}.`);
      if (n === loc.sorted) return setNote(`${name} already says ${n}.`);
    }
    setBusy(true);
    const error = mode === "back" ? await onPutBack(loc.boxCode, n) : await onFixCount(loc.boxCode, n);
    setBusy(false);
    setNote(error ?? (mode === "back" ? `Put ${n} back in ${name}.` : `${name} fixed: ${loc.sorted} sorted, really ${n}.`));
    if (!error) setOpenBox(null);
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-sm text-indigo-950">
      {headline && (
        <p className="mb-1.5 font-semibold">
          {total > 0
            ? `${total} here: ${pull.pulled.map((p) => `${boxShortName(p.boxCode)} x${p.units}`).join(", ")}. Grab them all.`
            : `Already gathered${gatheredBy ? ` by ${gatheredBy}` : ""}: ${pulledBefore} at the table.`}
        </p>
      )}
      {pulledBoxes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {pulledBoxes.map((l) => (
            <li key={l.boxCode}>
              <div className="flex items-center justify-between gap-2">
                <span className="tabular-nums">
                  {boxShortName(l.boxCode)}: {l.pulled} pulled
                  {l.inBox > 0 ? `, ${l.inBox} left in the box` : ""}
                </span>
                <span className="flex shrink-0 gap-3">
                  <button type="button" className="text-xs font-medium underline" onClick={() => open(l.boxCode, "back", 1)}>
                    Left some here
                  </button>
                  <button type="button" className="text-xs font-medium underline" onClick={() => open(l.boxCode, "count", l.sorted)}>
                    Count was off
                  </button>
                </span>
              </div>
              {openBox?.code === l.boxCode && (
                <div className="mt-1.5">
                  {openBox.mode === "count" && (
                    <p className="mb-1 text-xs">
                      The sort said {l.sorted}. How many were really in {boxShortName(l.boxCode)}?
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={openBox.mode === "back" ? 1 : 0}
                      max={openBox.mode === "back" ? l.pulled : undefined}
                      inputMode="numeric"
                      aria-label={
                        openBox.mode === "back"
                          ? `How many are still in ${boxShortName(l.boxCode)}`
                          : `How many were really in ${boxShortName(l.boxCode)}`
                      }
                      className="w-24"
                      value={units}
                      onChange={(e) => setUnits(e.target.value)}
                      onWheel={(e) => e.currentTarget.blur()}
                    />
                    <Button size="sm" variant="outline" onClick={() => save(l, openBox.mode)} disabled={busy}>
                      {busy ? "Saving…" : openBox.mode === "back" ? "Put back" : "Save count"}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="mt-1 text-xs">{note}</p>}
    </div>
  );
}
