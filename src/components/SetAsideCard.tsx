"use client";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { SetAsideWhy } from "@/components/PackSuggestionCard";
import { dudBoxName } from "@/lib/warehouse/codes";
import { LoaderCircle, PackageMinus } from "lucide-react";
import { useEffect, useState } from "react";

// The scan page's "Set aside" from the pack card, in warehouse mode
// (Cristian, 2026-11-03): the units go into the load's open dud box with the
// card's reason, instead of just being skipped. That keeps them with the
// rest of the duds to sell on Shopify & Whatnot (or try on eBay), and tells
// the Analyzer it called something sellable that wasn't worth it on eBay
// (src/lib/ebaySkips.ts). No open box: start one, its label prints at this
// station.
export function SetAsideCard({
  manifestId,
  upc,
  units,
  why,
  stationId,
  onDone,
  onCancel,
}: {
  manifestId: string;
  upc: string;
  units: number | null;
  why: SetAsideWhy;
  stationId: string | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [box, setBox] = useState<{ code: string } | null | undefined>(undefined);
  const [count, setCount] = useState(String(units && units > 0 ? units : 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ status: "open", manifestId });
    fetch(`/api/dud-boxes?${params}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data: { boxes?: { code: string }[] } | null) => {
        if (cancelled) return;
        // Newest first: the box the sorter (or the last set-aside) opened.
        setBox(data?.boxes?.[0] ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [manifestId]);

  async function startBox() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/dud-boxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestId, stationId }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.box) throw new Error(data?.error ?? "Couldn't start a dud box.");
      setBox({ code: data.box.code });
      setNote(
        data.printed
          ? `${dudBoxName(data.box.code)} started. Stick its label on a box.`
          : `${dudBoxName(data.box.code)} started${data.printError ? `, but its label didn't print: ${data.printError}` : ". Print its label from the Duds page."}`
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function putAside() {
    if (!box) return;
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) return setError("Enter how many, at least 1.");
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/dud-boxes/${encodeURIComponent(box.code)}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestId, upc, quantity: n, setAsideReason: why }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error ?? "Couldn't set it aside.");
      onDone(`Set aside ${n} in ${dudBoxName(box.code)}. Ready for the next item.`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      <div className="flex gap-2">
        <PackageMinus className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Set it aside in a dud box</p>
          {box === undefined ? (
            <p className="mt-1 flex items-center gap-2 text-amber-900/80">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Finding this load&apos;s open dud box…
            </p>
          ) : box === null ? (
            <>
              <p className="mt-0.5 text-amber-900/80">This load has no open dud box. Start one, its label prints here.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={startBox} disabled={busy}>
                  Start a dud box
                </Button>
                <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
                  Back
                </Button>
              </div>
            </>
          ) : (
            <>
              {note && <p className="mt-0.5 text-amber-900/80">{note}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span>Put</span>
                <Input
                  className="w-20"
                  type="number"
                  min={1}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                  aria-label="How many to set aside"
                />
                <span>
                  in <span className="font-semibold">{dudBoxName(box.code)}</span>
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={putAside} disabled={busy}>
                  Set aside, scan the next item
                </Button>
                <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
                  Back
                </Button>
              </div>
            </>
          )}
          {error && (
            <>
              <p className="mt-2 text-red-700">{error}</p>
              {/* Can't be recorded (nothing sorted for it, say): still let
                  them move on. */}
              <button
                type="button"
                className="mt-1 text-xs font-medium underline"
                onClick={() => onDone("Skipped without recording it.")}
                disabled={busy}
              >
                Skip it without recording
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
