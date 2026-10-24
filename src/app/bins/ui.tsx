"use client";

import type { BinDetail, BinSummary, ItemRow } from "@/app/api/bins/shared";
import BarcodeScanner from "@/components/BarcodeScanner";
import { ScanField } from "@/components/ScanField";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { cn } from "@/components/ui/cn";
import type { ShelfState } from "@/lib/warehouse/shelves";
import type { ItemLocation } from "@/lib/warehouse/types";
import { Camera, CircleAlert, CircleCheck, Info, Package } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

// Pieces shared by the Bins page's tabs.

export type { BinDetail, BinSummary, ItemRow, ShelfState };

export type LookupResult =
  | ({ kind: "bin" } & BinDetail)
  | { kind: "item"; item: ItemRow; location: ItemLocation; notInBins: number }
  | { kind: "items"; items: { item: ItemRow; location: ItemLocation; notInBins: number }[] }
  | {
      kind: "shelf";
      shelf: string;
      state: ShelfState;
      bins: BinSummary[];
      legacyItems: { item: ItemRow; location: ItemLocation; notInBins: number }[];
      legacyCount: number;
    };

// fetch + "throw the server's own error message" in one place.
export async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    ...(body !== undefined
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Something went wrong. Try again.");
  return data as T;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong. Try again.";
}

// Short tone so the result registers without looking at the screen (same
// sounds as the consignment pick page: one high beep = done, two low =
// problem, one middle = scanned, now the next step).
export function beep(kind: "ok" | "error" | "next") {
  try {
    const ctx = new AudioContext();
    const tones = kind === "ok" ? [880] : kind === "error" ? [220, 220] : [440];
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      const start = ctx.currentTime + i * 0.2;
      osc.start(start);
      osc.stop(start + 0.14);
    });
    navigator.vibrate?.(kind === "error" ? [80, 60, 80] : 80);
  } catch {
    // No audio (or no permission yet) is fine: the screen shows the result.
  }
}

// Puts the cursor back in a scan field so the next scan lands there.
export function focusField(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

// A scan field plus a camera button for phones without a built-in
// scanner. onScan gets the scanned text; the field clears itself.
export function ScanStep({
  id,
  label,
  prompt,
  hint,
  onScan,
  autoFocus = true,
  disabled = false,
}: {
  id: string;
  label: string;
  prompt: string;
  hint?: ReactNode;
  onScan: (code: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  function submit(raw: string) {
    setValue("");
    const code = raw.trim();
    if (!code || disabled) return;
    onScan(code);
  }
  return (
    <>
      <ScanField
        id={id}
        label={label}
        prompt={prompt}
        hint={hint}
        autoFocus={autoFocus}
        value={value}
        onChange={setValue}
        onScan={() => submit(value)}
        trailing={
          <Button
            variant="outline"
            size="icon-xl"
            onClick={() => setCameraOpen(true)}
            aria-label="Use the camera"
            title="Use the camera"
          >
            <Camera className="size-5" aria-hidden />
          </Button>
        }
      />
      {cameraOpen && (
        <BarcodeScanner
          onDetected={(code) => {
            setCameraOpen(false);
            submit(code);
          }}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </>
  );
}

export type Banner = { tone: "success" | "danger" | "info"; title: string; lines?: string[] };

// The big "it worked / it didn't" panel, readable at arm's length.
export function BannerPanel({ banner }: { banner: Banner }) {
  const Icon = banner.tone === "success" ? CircleCheck : banner.tone === "danger" ? CircleAlert : Info;
  return (
    <div
      role="status"
      className={cn(
        "rounded-2xl p-5 text-white shadow-sm",
        banner.tone === "success" ? "bg-success" : banner.tone === "danger" ? "bg-danger" : "bg-primary"
      )}
    >
      <div className="flex items-center gap-3">
        <Icon className="size-9 shrink-0" aria-hidden />
        <p className="text-2xl font-bold leading-tight tracking-tight">{banner.title}</p>
      </div>
      {banner.lines?.filter(Boolean).map((line) => (
        <p key={line} className="mt-2 text-base font-medium leading-snug opacity-95">
          {line}
        </p>
      ))}
    </div>
  );
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// What people call a bin: its code, or "Shelf A5" for an oversized
// shelf's hidden bin (items straight on the shelf).
export function binName(bin: Pick<BinSummary, "code" | "oversizedShelf">): string {
  return bin.oversizedShelf ? `Shelf ${bin.oversizedShelf}` : bin.code;
}

export function binCounts(bin: Pick<BinSummary, "items" | "units">): string {
  return bin.items === 0 ? "Empty" : `${plural(bin.units, "unit")}, ${plural(bin.items, "item")}`;
}

export function BinStatusBadge({ bin }: { bin: Pick<BinSummary, "status" | "shelfLabel"> }) {
  if (bin.status === "empty") {
    return <Badge tone={bin.shelfLabel ? "warning" : "success"}>{bin.shelfLabel ? `Empty, still on ${bin.shelfLabel}` : "Empty"}</Badge>;
  }
  if (bin.status === "filling") return <Badge tone="primary">Open, filling</Badge>;
  if (bin.status === "ready") return <Badge tone="purple">Ready to shelve</Badge>;
  return <Badge>Shelf {bin.shelfLabel}</Badge>;
}

export function formatExp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  // Dates are stored as midnight UTC; show the month/year printed on the
  // product, not the day before in Chicago time.
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

// One item line: photo, name, label code, and whatever the caller adds.
export function ItemLine({ item, right, sub }: { item: ItemRow; right?: ReactNode; sub?: ReactNode }) {
  const exp = formatExp(item.expirationDate);
  const hasLabel = /^ES\d+$/.test(item.code);
  return (
    <div className="flex items-start gap-3">
      {item.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.photoUrl} alt="" className="size-14 shrink-0 rounded-lg border border-border object-cover" />
      ) : (
        <span className="grid size-14 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Package className="size-5" aria-hidden />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">{item.title}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">{hasLabel ? item.code : item.upc ? `UPC ${item.upc}` : "No label"}</span>
          {item.packSize ? <span>{item.packSize}-pack</span> : null}
          {exp ? <span>Exp {exp}</span> : null}
        </p>
        {sub}
      </div>
      {right && <div className="shrink-0 text-right">{right}</div>}
    </div>
  );
}

type Station = { id: string; name: string; online: boolean };

const STATION_KEY = "bins.printStationId";

// Station picker + print button. Labels print on that station PC's Rollo.
// The chosen station is remembered on this device.
export function PrintToStation({
  label,
  disabled,
  onPrint,
}: {
  label: string;
  disabled?: boolean;
  onPrint: (stationId: string) => Promise<string>;
}) {
  const [stations, setStations] = useState<Station[] | null>(null);
  const [stationId, setStationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/stations")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Station[] | { stations?: Station[] }) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : (data.stations ?? []);
        setStations(list);
        let saved = "";
        try {
          saved = localStorage.getItem(STATION_KEY) ?? "";
        } catch {
          // Private mode: just pick the first one.
        }
        const pick = list.find((s) => s.id === saved) ?? list.find((s) => s.online) ?? list[0];
        setStationId(pick?.id ?? "");
      })
      .catch(() => !cancelled && setStations([]));
    return () => {
      cancelled = true;
    };
  }, []);

  async function print() {
    if (!stationId) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await onPrint(stationId) });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (stations && stations.length === 0) {
    return <p className="text-sm text-muted-foreground">No stations set up yet. Open the Station page on the PC with the label printer.</p>;
  }
  const chosen = stations?.find((s) => s.id === stationId);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={stationId}
          onChange={(e) => {
            setStationId(e.target.value);
            try {
              localStorage.setItem(STATION_KEY, e.target.value);
            } catch {
              // Not remembered, that's all.
            }
          }}
          aria-label="Station"
          className="min-w-0 flex-1"
        >
          {!stations && <option value="">Loading stations…</option>}
          {stations?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.online ? "" : " (offline)"}
            </option>
          ))}
        </Select>
        <Button onClick={print} disabled={disabled || busy || !stationId}>
          {busy ? "Sending…" : label}
        </Button>
      </div>
      {chosen && !chosen.online && (
        <p className="text-xs text-warning">That station looks offline. Labels will print once its page is open again.</p>
      )}
      {message && <p className={cn("text-sm", message.ok ? "text-success" : "text-danger")}>{message.text}</p>}
    </div>
  );
}

// A shelf's cutover state in a few words (see src/lib/warehouse/shelves.ts).
export function describeShelf(s: ShelfState): string {
  if (s.oversized) return `Oversized, no bins (${plural(s.oversizedUnits, "unit")})`;
  switch (s.state) {
    case "free":
      return s.bins > 0 ? `Using bins (${plural(s.bins, "bin")})` : "Ready for bins";
    case "bins":
      return `Using bins (${plural(s.bins, "bin")})`;
    case "looks_empty":
      return "Looks empty, confirm";
    case "old_items":
      return `${plural(s.oldItems, "old item")} left (${plural(s.oldUnits, "unit")})`;
  }
}

export function shelfTone(s: ShelfState): "success" | "warning" | "neutral" | "primary" {
  if (s.oversized) return "primary";
  return s.state === "free" || s.state === "bins" ? "success" : s.state === "looks_empty" ? "warning" : "neutral";
}

// "I looked, it's really empty": lets bins go on a shelf whose old-system
// items are all gone by the records. Anyone can tap it; it records who.
export function ConfirmEmptyButton({
  shelf,
  onConfirmed,
  size = "lg",
}: {
  shelf: string;
  onConfirmed: (state: ShelfState) => void;
  size?: "md" | "lg" | "xl";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ shelf: ShelfState }>("/api/bins/shelves/confirm-empty", { shelfLabel: shelf });
      beep("ok");
      onConfirmed(res.shelf);
    } catch (e) {
      beep("error");
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Button size={size} variant="warning" block onClick={confirm} disabled={busy}>
        {busy ? "Saving…" : `Confirm shelf ${shelf} is empty`}
      </Button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
