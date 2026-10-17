"use client";

import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import type { StationStatus } from "@/lib/warehouse/types";
import { CircleCheck, LoaderCircle, Scale, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Live scale reading from a listing station, for the scan page's weight
// step. The station PC (/station/{id}) reads its Dymo M25 over USB and
// reports each reading to the server; the handheld polls for it here. Only
// polls while `active` (on the weight step), so a handheld sitting on any
// other step isn't hitting the API several times a second.
const POLL_MS = 700;

export function useStationWeight(
  stationId: string | null,
  active: boolean,
  // Called with each settled, above-zero reading. Called from the fetch
  // handler (not an effect) and through a ref, so it always sees the page's
  // latest state.
  onStableReading?: (oz: number) => void
) {
  const [status, setStatus] = useState<StationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onStableRef = useRef(onStableReading);
  useEffect(() => {
    onStableRef.current = onStableReading;
  });

  useEffect(() => {
    if (!stationId || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    // One request at a time, the next one 700ms after the last answer: a
    // slow connection on the warehouse floor never piles requests up.
    async function poll() {
      try {
        const r = await fetch(`/api/stations/${stationId}`, { signal: controller.signal, cache: "no-store" });
        const data = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok || !data) {
          setError(data?.error ?? "Couldn't reach the station.");
        } else {
          // Number() in case the reading arrives as a Decimal string.
          const s: StationStatus = { ...data, weightOz: data.weightOz == null ? null : Number(data.weightOz) };
          setStatus(s);
          setError(null);
          if (s.online && s.weightStable && s.weightOz != null && s.weightOz > 0) onStableRef.current?.(s.weightOz);
        }
      } catch {
        if (cancelled) return;
        setError("Couldn't reach the station.");
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }
    poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [stationId, active]);

  return { status: stationId ? status : null, error };
}

// Package weight eBay gets: the item on the scale plus the empty box,
// rounded UP to a whole ounce (rounding down would under-pay the label).
// Rounded to hundredths first, so float noise (15.000000000000002) can't
// push an exact 15 oz up to 16.
export function packageWeight(itemOz: number, tareOz: number | null): { totalOz: number; lbs: number; oz: number } {
  const totalOz = Math.ceil(Math.round((itemOz + (tareOz ?? 0)) * 100) / 100);
  return { totalOz, lbs: Math.floor(totalOz / 16), oz: totalOz % 16 };
}

export const formatOz = (oz: number) => `${oz.toFixed(1)} oz`;

export function formatLbOz(lbs: number, oz: number): string {
  return lbs > 0 ? `${lbs} lb ${oz} oz` : `${oz} oz`;
}

// The big readout: what the scale says right now, whether it's settled,
// and a button to take it. Offline/no-reading states say what to do.
export function LiveWeightReadout({
  status,
  error,
  onUse,
}: {
  status: StationStatus | null;
  error: string | null;
  onUse: (oz: number) => void;
}) {
  if (!status && !error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-4 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Connecting to the scale…
      </div>
    );
  }
  if (!status || !status.online) {
    return (
      <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <WifiOff className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden />
        <p>
          {status ? <strong>{status.name} is offline.</strong> : <strong>{error}</strong>} No live weight, so type it in
          below. (Is the Station page open on that PC?)
        </p>
      </div>
    );
  }
  const reading = status.weightOz;
  const hasReading = reading != null && reading > 0;
  const lbs = reading != null ? Math.floor(reading / 16) : 0;
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        hasReading && status.weightStable ? "border-green-200 bg-green-50/60" : "border-border bg-background"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Scale className="size-4" aria-hidden />
            {status.name} scale
          </p>
          <p className="mt-1 text-4xl font-semibold tabular-nums tracking-tight text-foreground">
            {reading != null ? formatOz(reading) : "--"}
          </p>
          {reading != null && reading >= 16 && (
            <p className="text-sm tabular-nums text-muted-foreground">
              {lbs} lb {(reading - lbs * 16).toFixed(1)} oz
            </p>
          )}
        </div>
        {reading == null ? (
          <span className="text-xs text-muted-foreground">No reading yet</span>
        ) : status.weightStable ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-success">
            <CircleCheck className="size-4" aria-hidden />
            Stable
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-warning">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Settling
          </span>
        )}
      </div>
      {reading == null && (
        <p className="mt-2 text-sm text-muted-foreground">Is the scale on and plugged into the station PC?</p>
      )}
      <Button
        variant="outline"
        size="lg"
        block
        className="mt-3"
        disabled={!hasReading}
        onClick={() => reading != null && onUse(reading)}
      >
        Use this weight
      </Button>
    </div>
  );
}
