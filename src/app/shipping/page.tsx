"use client";

import { ScanField } from "@/components/ScanField";
import { ShippingLabelsCard } from "@/components/ShippingLabelsCard";
import { ScanStationCard, StationOnline } from "@/components/StationPicker";
import { StationSignOutButton, useStationChosen, useStationLeft } from "@/components/StationSignIn";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { normalizeCode } from "@/lib/warehouse/codes";
import { printPage } from "@/lib/warehouse/labelPrint";
import type { LabelPrintResult, LabelRow } from "@/lib/warehouse/shippingLabels";
import type { StationStatus } from "@/lib/warehouse/types";
import { CircleCheck, CircleX, Info, Monitor, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// Shipping (Cristian, 2026-10-21): the shipping station's own page, split
// off Pick orders. Labels print at the station this device signed in at
// by scanning its QR code (Cristian, 2026-10-26: no picking from a list),
// or this PC's own station; the packing station until then. Then: upload eBay's bulk
// label PDF, and scan each box's pick slip: that order's label prints at
// the station right away (warehouse/shippingLabels.ts).

const SCAN_ID = "shipping-slip";
const AUTO_REFRESH_MS = 60_000;
const STATION_KEY = "ebay-tool.shippingStationId";
// What an eBay pick slip's barcode holds: the order number.
const EBAY_ORDER_RE = /^\d{2}-\d{5}-\d{5}$/;

type Result = {
  tone: "good" | "bad" | "info";
  headline: string;
  detail?: string;
  note?: string | null;
  action?: { label: string; run: () => void };
};

function loadStationId(): string | null {
  try {
    return localStorage.getItem(STATION_KEY);
  } catch {
    return null;
  }
}

function saveStationId(id: string) {
  try {
    localStorage.setItem(STATION_KEY, id);
  } catch {
    // Not remembered on this device; it still works for this visit.
  }
}

function beep(kind: Result["tone"]) {
  try {
    const ctx = new AudioContext();
    const tones = kind === "good" ? [880] : kind === "bad" ? [220, 220] : [440];
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
    navigator.vibrate?.(kind === "good" ? 80 : [80, 60, 80]);
  } catch {
    // No audio is fine: the screen shows the answer.
  }
}

function focusScan() {
  setTimeout(() => document.getElementById(SCAN_ID)?.focus(), 0);
}

export default function ShippingPage() {
  const [stations, setStations] = useState<StationStatus[] | null>(null);
  const [stationsError, setStationsError] = useState<string | null>(null);
  const [stationId, setStationId] = useState<string | null>(() => (typeof window === "undefined" ? null : loadStationId()));
  useStationChosen(setStationId);
  useStationLeft((id) => setStationId((current) => (current === id ? null : current)));
  const [code, setCode] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [labels, setLabels] = useState<LabelRow[] | null>(null);
  const [assigningLabel, setAssigningLabel] = useState<string | null>(null);

  const loadStations = useCallback(async () => {
    try {
      const r = await fetch("/api/stations");
      const data = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(data)) throw new Error(data?.error ?? "Couldn't load the stations.");
      setStations(data as StationStatus[]);
      setStationsError(null);
    } catch (e) {
      setStationsError(e instanceof Error ? e.message : "Couldn't load the stations.");
    }
  }, []);

  const loadLabels = useCallback(async () => {
    try {
      const res = await fetch("/api/ship/labels");
      if (res.ok) setLabels(((await res.json()) as { labels: LabelRow[] }).labels);
    } catch {
      // The next refresh tries again.
    }
  }, []);

  useEffect(() => {
    // Both set state only after their fetch comes back.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStations();
    void loadLabels();
    const timer = setInterval(() => {
      if (document.hidden || busyRef.current) return;
      void loadStations();
      void loadLabels();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadStations, loadLabels]);

  // The scanned-into station, else the one marked for packing slips.
  const picked = stations?.find((s) => s.id === stationId) ?? null;
  const station = picked ?? stations?.find((s) => s.packingSlips) ?? null;

  // Nothing remembered: this browser may be a station PC itself, or the
  // person is signed in at one (GET /api/stations/mine).
  const [askedMine, setAskedMine] = useState(false);
  useEffect(() => {
    if (stations == null || picked != null || askedMine) return;
    let cancelled = false;
    fetch("/api/stations/mine")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { stationId: string | null } | null) => {
        if (cancelled) return;
        setAskedMine(true);
        if (d?.stationId && stations.some((s) => s.id === d.stationId)) {
          saveStationId(d.stationId);
          setStationId(d.stationId);
        }
      })
      .catch(() => !cancelled && setAskedMine(true));
    return () => {
      cancelled = true;
    };
  }, [stations, picked, askedMine]);

  function show(r: Result) {
    setResult(r);
    beep(r.tone);
  }

  // A pick slip scanned (or Reprint tapped): that order's label prints at
  // the station. With a label being assigned, the slip says which order
  // it's for first.
  async function printLabel(orderId: string, force: boolean) {
    busyRef.current = true;
    setBusy(true);
    const assign = assigningLabel;
    try {
      const res = await fetch("/api/ship/labels/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, force, assignLabelId: assign, stationId: station?.id ?? null }),
      });
      const json = (await res.json()) as LabelPrintResult | { error: string };
      if (!res.ok || "error" in json) throw new Error("error" in json ? json.error : "Couldn't print the label.");
      if (assign) setAssigningLabel(null);
      const sameBox =
        "others" in json && json.others.length > 0 ? `Same label as order ${json.others.join(", ")}: they go in one box.` : null;
      if (json.status === "queued") {
        show({
          tone: "good",
          headline: json.reprint ? "Label printing again" : "Label printing",
          detail: json.online
            ? `Order ${orderId} at ${json.station}. Stick it on and toss the slip.`
            : `Order ${orderId} sent to ${json.station}, but it isn't online. It prints when its page or print helper is running.`,
          note: sameBox,
        });
      } else if (json.status === "print_here") {
        await printPage(json.html, { width: "4in", height: "6in" });
        show({ tone: "good", headline: "Label sent to this device's printer", detail: `Order ${orderId}. No station is set up.`, note: sameBox });
      } else if (json.status === "already") {
        show({
          tone: "info",
          headline: "Label already printed",
          detail: `Order ${orderId}, ${new Date(json.printedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${json.printedBy ? ` by ${json.printedBy}` : ""}.`,
          note: "Jammed or lost? Print it again.",
          action: { label: "Print again", run: () => void printLabel(orderId, true) },
        });
      } else if (json.status === "image_gone") {
        show({ tone: "bad", headline: "Label not kept anymore", detail: `Order ${orderId}'s label was deleted. Upload the label PDF again, or reprint it from eBay.` });
      } else {
        show({
          tone: "bad",
          headline: "No label for this order",
          detail: `Order ${orderId} has no uploaded label yet.`,
          note: "Upload eBay's label PDF below. If it's uploaded but didn't match, tap Assign on that label, then scan this slip.",
        });
      }
      void loadLabels();
    } catch (e) {
      show({ tone: "bad", headline: "Label didn't print", detail: e instanceof Error ? e.message : "Try again." });
    } finally {
      busyRef.current = false;
      setBusy(false);
      focusScan();
    }
  }

  async function handleScan() {
    const scanned = normalizeCode(code);
    setCode("");
    if (!scanned || busyRef.current) return;
    if (EBAY_ORDER_RE.test(scanned)) {
      await printLabel(scanned, false);
      return;
    }
    if (/^#?\d{3,6}$/.test(scanned)) {
      show({ tone: "info", headline: "Shopify order", detail: `Order #${scanned.replace(/^#/, "")}: buy and print its label in Shopify admin.` });
    } else {
      show({ tone: "bad", headline: "Not a pick slip", detail: "Scan the barcode on the pick slip clipped to the box." });
    }
    focusScan();
  }

  // Stations change only by scanning one's QR code (Cristian, 2026-10-26).
  if (stationsError || (stations && stations.length > 0 && !station && askedMine)) {
    return (
      <AppShell title="Shipping" width="narrow" subtitle="Scan the station where the labels should print.">
        <ScanStationCard
          description="Labels print on its 4x6 printer."
          error={stationsError}
          onReload={() => void loadStations()}
        />
      </AppShell>
    );
  }

  return (
    <AppShell title="Shipping" width="narrow" subtitle="Scan a box's pick slip and its label prints.">
      <div className="flex flex-col gap-5">
        {stationsError && <Alert tone="danger">{stationsError}</Alert>}
        {station && (
          <Card padded={false} className="flex items-center gap-3 p-3">
            <Monitor className="size-5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Labels print at</p>
              <p className="truncate font-semibold text-foreground">
                {station.name}
                {station.helperActive && station.printerName ? (
                  <span className="font-normal text-muted-foreground"> · {station.printerName}</span>
                ) : null}
              </p>
            </div>
            <StationOnline online={station.online || station.helperActive} />
            <StationSignOutButton stationId={station.id} stationName={station.name} />
          </Card>
        )}

        {result && <ResultPanel result={result} busy={busy} onClose={() => setResult(null)} />}

        <ScanField
          id={SCAN_ID}
          label={assigningLabel ? "Assigning a label" : "Pick slip"}
          prompt={assigningLabel ? "Scan the pick slip for that label" : "Scan the pick slip on the box"}
          autoFocus
          value={code}
          onChange={setCode}
          onScan={() => void handleScan()}
          hint={
            assigningLabel ? (
              <span className="inline-flex items-center gap-1">
                The next slip you scan gets that label.
                <button type="button" className="font-medium text-primary underline" onClick={() => setAssigningLabel(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              "Its shipping label prints at the station right away."
            )
          }
        />

        <ShippingLabelsCard
          labels={labels}
          onChanged={() => void loadLabels()}
          assigningId={assigningLabel}
          onAssign={(id) => {
            setAssigningLabel(id);
            setResult(null);
            focusScan();
          }}
          onReprint={(orderId) => void printLabel(orderId, true)}
          busy={busy}
        />
      </div>
    </AppShell>
  );
}

function ResultPanel({ result, busy, onClose }: { result: Result; busy: boolean; onClose: () => void }) {
  const Icon = result.tone === "good" ? CircleCheck : result.tone === "bad" ? CircleX : Info;
  return (
    <div
      role="status"
      className={cn(
        "relative rounded-2xl p-5 text-white shadow-sm",
        result.tone === "good" ? "bg-success" : result.tone === "bad" ? "bg-danger" : "bg-primary"
      )}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="absolute right-2 top-2 grid size-9 place-items-center rounded-md text-white/80 hover:bg-white/10"
      >
        <X className="size-5" aria-hidden />
      </button>
      <div className="flex items-center gap-3 pr-8">
        <Icon className="size-10 shrink-0" aria-hidden />
        <p className="text-2xl font-bold leading-tight tracking-tight">{result.headline}</p>
      </div>
      {result.detail && <p className="mt-3 text-lg font-semibold leading-snug">{result.detail}</p>}
      {result.note && <p className="mt-1 text-sm opacity-90">{result.note}</p>}
      {result.action && (
        <button
          type="button"
          disabled={busy}
          onClick={result.action.run}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-sm font-medium hover:bg-white/25 disabled:opacity-50"
        >
          {result.action.label}
        </button>
      )}
    </div>
  );
}
