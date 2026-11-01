"use client";

import type { SortLocation } from "@/lib/warehouse/sortBoxes";
import { useState } from "react";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";

// Where this product's units were in the sort boxes, so the lister (or
// the lister's helper on /gather) can grab them all at once. "Left some
// here" fixes a box's count when not every unit got taken out. Used by the
// List page and /gather; headline={false} when the page shows its own.
export function SortBoxesCard({
  pull,
  onPutBack,
  headline = true,
}: {
  pull: { pulled: { boxCode: string; units: number }[]; locations: SortLocation[] };
  onPutBack: (boxCode: string, units: number) => Promise<string | null>;
  headline?: boolean;
}) {
  const [openBox, setOpenBox] = useState<string | null>(null);
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

  async function save(boxCode: string) {
    const n = Number(units);
    if (!Number.isInteger(n) || n < 1) return setNote("Enter how many are still in the box.");
    setBusy(true);
    const error = await onPutBack(boxCode, n);
    setBusy(false);
    setNote(error ?? `Put ${n} back in ${boxCode}.`);
    if (!error) setOpenBox(null);
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-sm text-indigo-950">
      {headline && (
        <p className="mb-1.5 font-semibold">
          {total > 0
            ? `${total} here: ${pull.pulled.map((p) => `${p.boxCode} x${p.units}`).join(", ")}. Grab them all.`
            : `Already gathered${gatheredBy ? ` by ${gatheredBy}` : ""}: ${pulledBefore} at the table.`}
        </p>
      )}
      {pulledBoxes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {pulledBoxes.map((l) => (
            <li key={l.boxCode}>
              <div className="flex items-center justify-between gap-2">
                <span className="tabular-nums">
                  {l.boxCode}: {l.pulled} pulled
                  {l.inBox > 0 ? `, ${l.inBox} left in the box` : ""}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-xs font-medium underline"
                  onClick={() => {
                    setOpenBox(openBox === l.boxCode ? null : l.boxCode);
                    setUnits("1");
                    setNote(null);
                  }}
                >
                  Left some here
                </button>
              </div>
              {openBox === l.boxCode && (
                <div className="mt-1.5 flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={l.pulled}
                    inputMode="numeric"
                    aria-label={`How many are still in ${l.boxCode}`}
                    className="w-24"
                    value={units}
                    onChange={(e) => setUnits(e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                  <Button size="sm" variant="outline" onClick={() => save(l.boxCode)} disabled={busy}>
                    {busy ? "Saving…" : "Put back"}
                  </Button>
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
