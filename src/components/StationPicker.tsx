"use client";

import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import type { StationStatus } from "@/lib/warehouse/types";
import { Check, LoaderCircle, Monitor } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

// Which listing station (PC with the scale and label printer) this handheld
// works at. Picked once and remembered on the device, since a handheld
// normally stays at one station all day. The live weight comes from that
// station's scale, and the labels print on its Rollo.
const STATION_KEY = "ebay-tool.stationId";

// localStorage can throw (private window, storage blocked), and a missing
// station is fine: the page just asks for one again.
function loadStationId(): string | null {
  try {
    return localStorage.getItem(STATION_KEY);
  } catch {
    return null;
  }
}

function saveStationId(id: string | null) {
  try {
    if (id) localStorage.setItem(STATION_KEY, id);
    else localStorage.removeItem(STATION_KEY);
  } catch {
    // Not remembered on this device; it still works for this visit.
  }
}

// The station this device picked, plus the list to pick from. Only fetches
// when `enabled` (warehouse mode on), so the normal scan page doesn't call
// a stations API it has no use for.
export function useChosenStation(enabled: boolean) {
  const [stationId, setStationId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : loadStationId()
  );
  const [stations, setStations] = useState<StationStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/stations")
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(data)) throw new Error(data?.error ?? "Couldn't load the stations.");
        return data as StationStatus[];
      })
      .then((list) => {
        if (cancelled) return;
        setStations(list);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load the stations."));
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);

  // A remembered station that's since been deleted counts as none.
  const station = stations?.find((s) => s.id === stationId) ?? null;

  function choose(id: string | null) {
    saveStationId(id);
    setStationId(id);
  }

  return {
    station,
    stations,
    // Loaded and this device has no (existing) station picked.
    needsStation: enabled && stations != null && station == null,
    error,
    choose,
    reload: () => setReloadKey((k) => k + 1),
  };
}

export function StationPicker({
  stations,
  selectedId,
  error,
  onPick,
  onCancel,
  onReload,
}: {
  stations: StationStatus[] | null;
  selectedId: string | null;
  error?: string | null;
  onPick: (station: StationStatus) => void;
  onCancel?: () => void;
  onReload?: () => void;
}) {
  return (
    <Card>
      <SectionHeader
        title="Which station are you at?"
        description="The weight comes from its scale and the labels print there. This handheld remembers it."
      />
      {error ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-danger">{error}</p>
          {onReload && (
            <Button variant="outline" onClick={onReload}>
              Try again
            </Button>
          )}
        </div>
      ) : stations == null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Loading stations…
        </p>
      ) : stations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No stations yet. Set one up on the{" "}
          <Link href="/station" className="font-medium text-primary hover:underline">
            Station page
          </Link>{" "}
          on the PC with the scale.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {stations.map((s) => {
            const selected = s.id === selectedId;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onPick(s)}
                  className={cn(
                    "flex h-14 w-full items-center gap-3 rounded-lg border px-3 text-left transition-colors",
                    selected
                      ? "border-primary bg-blue-50 text-primary"
                      : "border-border bg-surface text-foreground hover:bg-muted active:bg-muted"
                  )}
                >
                  <Monitor className="size-5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-base font-medium">{s.name}</span>
                  <StationOnline online={s.online} />
                  {selected && <Check className="size-5 shrink-0" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {onCancel && (
        <Button variant="ghost" block onClick={onCancel} className="mt-3">
          Cancel
        </Button>
      )}
    </Card>
  );
}

export function StationOnline({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium",
        online ? "text-success" : "text-muted-foreground"
      )}
    >
      <span className={cn("size-2 rounded-full", online ? "bg-green-500" : "bg-zinc-300")} aria-hidden />
      {online ? "Online" : "Offline"}
    </span>
  );
}
