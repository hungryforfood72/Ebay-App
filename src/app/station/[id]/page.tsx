"use client";

import { LabelPreview } from "@/components/labels/LabelPreview";
import { isLabelKind, itemMetaLine } from "@/components/labels/labelMarkup";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { printLabels, printPage } from "@/lib/warehouse/labelPrint";
import { formatOunces, formatPoundsOunces, scaleStatusMessage } from "@/lib/warehouse/scale";
import type { PrintJobRow } from "@/lib/warehouse/stations";
import { isPageKind, type CodeLabelPayload, type ItemLabelPayload, type PageJobPayload, type PrintJobKind, type PrintJobPayload, type StationStatus } from "@/lib/warehouse/types";
import { Copy, Printer, RotateCcw, Scale, Usb } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useScale } from "./useScale";
import { useTicker } from "./useTicker";

// The page left open full-screen on a listing station PC. It does three
// jobs, all on its own once it's set up:
//   1. Reads the USB scale (useScale) and reports the weight to the server
//      (heartbeat), where the lister's handheld picks it up.
//   2. Checks for queued labels and prints them on the Rollo.
//   3. Shows what's going on, with a print log and Reprint buttons.
//
// Timing (all driven by one 250ms worker tick, see useTicker):
//   heartbeat: right after the weight changes, at most 4 a second, and at
//     least every 10s so the station stays "online".
//   labels: every 1.5s if anything happened in the last 2 minutes (a label
//     printed, the weight moved), every 5s otherwise. Saves Vercel calls
//     while the station sits idle.

const TICK_MS = 250;
const HEARTBEAT_MIN_GAP_MS = 250;
const HEARTBEAT_IDLE_MS = 10_000;
const HEARTBEAT_RETRY_MS = 2_000;
const POLL_ACTIVE_MS = 1_500;
const POLL_IDLE_MS = 5_000;
const ACTIVE_WINDOW_MS = 2 * 60_000;
// A weight change at least this big counts as someone working here.
const ACTIVITY_OZ = 0.2;

type ServerState = "connecting" | "online" | "offline" | "signed-out" | "deleted";

type QueuedJob = { id: string; kind: string; payload: PrintJobPayload; copies: number };

const TEST_LABEL: ItemLabelPayload = {
  code: "ES000123",
  name: "Test label: Sample Vitamin C Gummies, Orange, 90 Count",
  packSize: 3,
  expiration: "03/2027",
  condition: "new",
};

export default function StationPage() {
  const { id } = useParams<{ id: string }>();
  const scale = useScale();
  const [station, setStation] = useState<StationStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [server, setServer] = useState<ServerState>("connecting");
  const [log, setLog] = useState<PrintJobRow[] | null>(null);
  const [nowPrinting, setNowPrinting] = useState<QueuedJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pollActive, setPollActive] = useState(true);

  const weightOz = scale.connection === "connected" ? (scale.reading?.weightOz ?? null) : null;
  const stable = weightOz !== null && Boolean(scale.reading?.stable);

  // Latest values for the tick, which runs outside React's render cycle.
  const readingRef = useRef({ weightOz, stable });
  const hb = useRef({ sentKey: "", sentAt: 0, inFlight: false });
  const poll = useRef({ busy: false, lastAt: 0 });
  // Set on mount so a freshly opened page starts out checking quickly.
  const lastActivityAt = useRef(0);
  const lastWeight = useRef<number | null>(null);
  const halted = useRef(false);

  useEffect(() => {
    readingRef.current = { weightOz, stable };
    if (weightOz !== null && (lastWeight.current === null || Math.abs(weightOz - lastWeight.current) >= ACTIVITY_OZ)) {
      lastActivityAt.current = Date.now();
    }
    lastWeight.current = weightOz;
  }, [weightOz, stable]);

  function handleStatus(status: number) {
    if (status === 401) {
      halted.current = true;
      setServer("signed-out");
    } else if (status === 404) {
      halted.current = true;
      setServer("deleted");
    } else {
      setServer("offline");
    }
  }

  async function loadLog() {
    try {
      const res = await fetch(`/api/stations/${id}/log?limit=25`, { cache: "no-store" });
      if (res.ok) setLog(await res.json());
    } catch {
      // The next print or reload tries again.
    }
  }

  useEffect(() => {
    lastActivityAt.current = Date.now();
    fetch(`/api/stations/${id}`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Couldn't load this station.");
        setStation(data as StationStatus);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load this station."));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function sendHeartbeat(key: string, reading: { weightOz: number | null; stable: boolean }) {
    const state = hb.current;
    state.inFlight = true;
    state.sentKey = key;
    state.sentAt = Date.now();
    try {
      const res = await fetch(`/api/stations/${id}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reading),
      });
      if (res.ok) setServer("online");
      else {
        handleStatus(res.status);
        state.sentAt = Date.now() - HEARTBEAT_IDLE_MS + HEARTBEAT_RETRY_MS;
      }
    } catch {
      setServer("offline");
      state.sentAt = Date.now() - HEARTBEAT_IDLE_MS + HEARTBEAT_RETRY_MS;
    } finally {
      state.inFlight = false;
    }
  }

  async function printJob(job: QueuedJob) {
    setNowPrinting(job);
    let result: { status: "printed" } | { status: "failed"; error: string } = { status: "printed" };
    try {
      if (isPageKind(job.kind)) {
        // Packing slip or local delivery label: a whole 4x6 page.
        const page = job.payload as unknown as PageJobPayload;
        for (let i = 0; i < job.copies; i++) await printPage(page.html, { width: "4in", height: "6in" });
      } else {
        if (!isLabelKind(job.kind)) throw new Error(`Unknown label type "${job.kind}".`);
        await printLabels(job.kind, job.payload, job.copies);
      }
    } catch (e) {
      result = { status: "failed", error: e instanceof Error ? e.message : "Printing failed." };
    }
    await fetch(`/api/print-jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    }).catch(() => {});
    setNowPrinting(null);
  }

  async function pollJobs() {
    const state = poll.current;
    state.busy = true;
    try {
      const res = await fetch(`/api/stations/${id}/jobs`, { cache: "no-store" });
      if (!res.ok) {
        handleStatus(res.status);
        return;
      }
      const jobs: QueuedJob[] = await res.json();
      if (jobs.length === 0) return;
      lastActivityAt.current = Date.now();
      for (const job of jobs) await printJob(job);
      lastActivityAt.current = Date.now();
      await loadLog();
    } catch {
      // Network blip; the next poll tries again.
    } finally {
      state.busy = false;
      state.lastAt = Date.now();
    }
  }

  useTicker(TICK_MS, () => {
    if (halted.current) return;
    const t = Date.now();

    const reading = readingRef.current;
    const key = `${reading.weightOz}|${reading.stable}`;
    const h = hb.current;
    if (
      !h.inFlight &&
      ((key !== h.sentKey && t - h.sentAt >= HEARTBEAT_MIN_GAP_MS) || t - h.sentAt >= HEARTBEAT_IDLE_MS)
    ) {
      void sendHeartbeat(key, reading);
    }

    const p = poll.current;
    const active = t - lastActivityAt.current < ACTIVE_WINDOW_MS;
    setPollActive(active);
    if (!p.busy && t - p.lastAt >= (active ? POLL_ACTIVE_MS : POLL_IDLE_MS)) void pollJobs();

    // Re-render once a second for "last reading 12s ago".
    if (Math.floor(t / 1000) !== Math.floor(now / 1000)) setNow(t);
  });

  // Queues through the server like any other label, so a test checks the
  // whole path: queue, pick up, print.
  async function queue(kind: PrintJobKind, payload: PrintJobPayload, copies = 1) {
    const res = await fetch(`/api/stations/${id}/print`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, payload, copies }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? "Couldn't queue the label.");
    }
  }

  async function testPrint() {
    setBusy(true);
    setMessage(null);
    try {
      await queue("item", TEST_LABEL);
      lastActivityAt.current = Date.now();
      poll.current.lastAt = 0; // check right away
      setMessage("Test label sent. It should print in a second or two.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't send the test label.");
    } finally {
      setBusy(false);
    }
  }

  // Makes this the packing station (packing slips + local delivery
  // labels), or stops it being one.
  async function setPackingSlips(on: boolean) {
    setMessage(null);
    try {
      const res = await fetch(`/api/stations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packingSlips: on }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't change that.");
      setStation(data as StationStatus);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't change that.");
    }
  }

  async function reprint(job: PrintJobRow) {
    setMessage(null);
    try {
      const res = await fetch(`/api/print-jobs/${job.id}/reprint`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Couldn't reprint.");
      }
      lastActivityAt.current = Date.now();
      poll.current.lastAt = 0;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't reprint.");
    }
  }

  const latest = log?.find((j) => isLabelKind(j.kind));
  const stopped = server === "signed-out" || server === "deleted";

  if (loadError) {
    return (
      <AppShell width="narrow" title="Station">
        <Alert tone="danger" title="Can't open this station">
          {loadError}
        </Alert>
      </AppShell>
    );
  }

  return (
    <AppShell width="wide" title={station?.name ?? "Station"} subtitle="Leave this page open on the station PC.">
      {server === "signed-out" && (
        <Alert tone="danger" title="Signed out" className="mb-4">
          This PC got signed out, so weights and labels stopped. Reload the page and sign in again.
        </Alert>
      )}
      {server === "deleted" && (
        <Alert tone="danger" title="This station was deleted" className="mb-4">
          Pick another station from the Station page.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <ScaleCard scale={scale} weightOz={weightOz} stable={stable} now={now} />

          <Card>
            <SectionHeader
              title="Labels"
              description="Labels sent to this station print here by themselves."
              action={
                <Button variant="outline" size="sm" onClick={testPrint} disabled={busy || stopped}>
                  <Printer className="size-4" aria-hidden />
                  Test print
                </Button>
              }
            />
            <label className="mb-3 flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={station?.packingSlips ?? false}
                disabled={!station || stopped}
                onChange={(e) => setPackingSlips(e.target.checked)}
              />
              <span>
                Packing slips print here
                <span className="block text-xs text-muted-foreground">
                  Only on a PC whose default printer has 4x6 labels. Each picked order&apos;s packing slip (and local delivery label)
                  prints here. One station at a time.
                </span>
              </span>
            </label>
            {message && <p className="mb-3 text-sm text-foreground">{message}</p>}
            {nowPrinting && (
              <p className="mb-3 text-sm font-medium text-primary">Printing {payloadCode(nowPrinting.payload)}…</p>
            )}
            {latest && (
              <div className="mb-4 flex flex-wrap items-center gap-4">
                <LabelPreview kind={latest.kind as PrintJobKind} payload={latest.payload as PrintJobPayload} scale={1.5} />
                <p className="text-sm text-muted-foreground">Last label sent to this station.</p>
              </div>
            )}
            <PrintLog log={log} onReprint={reprint} />
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <SectionHeader title="Status" />
            <ul className="flex flex-col gap-2 text-sm">
              <StatusRow
                ok={server === "online"}
                label="App"
                text={
                  server === "online"
                    ? "Connected"
                    : server === "connecting"
                      ? "Connecting…"
                      : server === "offline"
                        ? "Can't reach the app. Check the internet."
                        : server === "signed-out"
                          ? "Signed out"
                          : "Station deleted"
                }
              />
              <StatusRow
                ok={scale.connection === "connected"}
                label="Scale"
                text={scale.connection === "connected" ? (scale.deviceName ?? "Connected") : scaleConnectionText(scale.connection)}
              />
              <StatusRow
                ok={server === "online"}
                label="Printer"
                text={`Checking for labels every ${(pollActive ? POLL_ACTIVE_MS : POLL_IDLE_MS) / 1000}s`}
              />
            </ul>
          </Card>
          <SetupHelp stationId={id} />
        </div>
      </div>
    </AppShell>
  );
}

function scaleConnectionText(c: ReturnType<typeof useScale>["connection"]): string {
  switch (c) {
    case "checking":
      return "Looking for the scale…";
    case "unsupported":
      return "This browser can't read scales";
    case "not-set-up":
      return "Not connected yet";
    case "off":
      return "Off";
    case "error":
      return "Couldn't open it";
    default:
      return "Connected";
  }
}

function StatusRow({ ok, label, text }: { ok: boolean; label: string; text: string }) {
  return (
    <li className="flex items-start gap-2">
      <span
        className={ok ? "mt-1.5 size-2.5 shrink-0 rounded-full bg-green-500" : "mt-1.5 size-2.5 shrink-0 rounded-full bg-amber-500"}
        aria-hidden
      />
      <span className="min-w-0">
        <span className="font-medium text-foreground">{label}:</span> <span className="text-muted-foreground">{text}</span>
      </span>
    </li>
  );
}

function ScaleCard({
  scale,
  weightOz,
  stable,
  now,
}: {
  scale: ReturnType<typeof useScale>;
  weightOz: number | null;
  stable: boolean;
  now: number;
}) {
  const statusMessage = scale.reading ? scaleStatusMessage(scale.reading.status) : null;
  const quietFor = scale.lastReportAt ? Math.round((now - scale.lastReportAt) / 1000) : 0;

  return (
    <Card>
      <SectionHeader
        title="Scale"
        action={
          scale.connection === "connected" && weightOz !== null ? (
            <Badge tone={stable ? "success" : "warning"} size="lg">
              {stable ? "Steady" : "Settling…"}
            </Badge>
          ) : undefined
        }
      />

      {scale.connection === "connected" ? (
        weightOz !== null ? (
          <div className="py-4 text-center">
            <p className="text-7xl font-bold tracking-tight text-foreground tabular-nums sm:text-8xl">{formatOunces(weightOz)}</p>
            <p className="mt-2 text-2xl font-medium text-muted-foreground tabular-nums">{formatPoundsOunces(weightOz)}</p>
            {quietFor >= 10 && (
              <p className="mt-2 text-xs text-muted-foreground">No new reading for {quietFor}s.</p>
            )}
          </div>
        ) : (
          <div className="py-6 text-center">
            <p className="text-lg font-medium text-foreground">{statusMessage ?? "Waiting for a reading…"}</p>
          </div>
        )
      ) : scale.connection === "off" ? (
        <Alert
          tone="warning"
          title="Scale is off, press its power button"
          action={
            <Button variant="outline" size="sm" onClick={scale.connect}>
              <Usb className="size-4" aria-hidden />
              Still not working? Connect scale
            </Button>
          }
        >
          It turns itself off after a few idle minutes. It reconnects here on its own once it&apos;s on.
        </Alert>
      ) : scale.connection === "unsupported" ? (
        <Alert tone="danger" title="This browser can't read the scale">
          Open this page in Chrome or Edge on the station PC. Phones and tablets can&apos;t connect a USB scale.
        </Alert>
      ) : scale.connection === "checking" ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Looking for the scale…</p>
      ) : (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Scale className="size-10 text-muted-foreground" aria-hidden />
          <p className="max-w-sm text-sm text-muted-foreground">
            Plug the DYMO scale into this PC and turn it on, then connect it. You only need to do this once.
          </p>
          <Button size="lg" onClick={scale.connect}>
            <Usb className="size-5" aria-hidden />
            Connect scale
          </Button>
        </div>
      )}
      {scale.error && <p className="mt-3 text-sm font-medium text-danger">{scale.error}</p>}
    </Card>
  );
}

function payloadCode(payload: unknown): string {
  return (payload as { code?: string })?.code ?? "label";
}

// One readable line for a log row: the item name or the label's caption.
function payloadSummary(kind: string, payload: unknown): string {
  if (kind === "item") {
    const p = payload as ItemLabelPayload;
    return [p.name, itemMetaLine(p)].filter(Boolean).join(" · ");
  }
  return (payload as CodeLabelPayload).caption ?? "";
}

const STATUS_TONE: Record<string, BadgeTone> = {
  printed: "success",
  failed: "danger",
  printing: "primary",
  queued: "neutral",
};

const STATUS_TEXT: Record<string, string> = {
  printed: "Printed",
  failed: "Failed",
  printing: "Printing",
  queued: "Waiting",
};

function PrintLog({ log, onReprint }: { log: PrintJobRow[] | null; onReprint: (job: PrintJobRow) => void }) {
  if (!log) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (log.length === 0) return <p className="text-sm text-muted-foreground">Nothing printed here yet.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {log.map((job) => (
        <li key={job.id} className="flex items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono font-semibold text-foreground">{payloadCode(job.payload)}</span>
              <Badge tone={STATUS_TONE[job.status] ?? "neutral"}>{STATUS_TEXT[job.status] ?? job.status}</Badge>
              <span className="text-xs capitalize text-muted-foreground">
                {job.kind}
                {job.copies > 1 ? ` × ${job.copies}` : ""}
              </span>
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {new Date(job.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              {job.createdBy ? ` · ${job.createdBy}` : ""}
              {payloadSummary(job.kind, job.payload) ? ` · ${payloadSummary(job.kind, job.payload)}` : ""}
            </p>
            {job.status === "failed" && job.error && <p className="text-xs font-medium text-danger">{job.error}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => onReprint(job)} className="shrink-0">
            <RotateCcw className="size-4" aria-hidden />
            Reprint
          </Button>
        </li>
      ))}
    </ul>
  );
}

// One-time setup for a station PC. Shown on the page itself because that's
// where you are when you're setting one up.
function SetupHelp({ stationId }: { stationId: string }) {
  const [origin, setOrigin] = useState("https://ebay-app-iota.vercel.app");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    // window only exists in the browser, after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
  }, []);

  const shortcut = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing --app=${origin}/station/${stationId}`;
  // Chrome policy that always lets this site use the DYMO M25 (USB ids
  // 0x0922 / 0x8004 = 2338 / 32772), for when Chrome forgets the scale
  // every time it powers off.
  const policy = [
    "Windows Registry Editor Version 5.00",
    "",
    "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome]",
    `"WebHidAllowDevicesForUrls"="[{\\"devices\\":[{\\"vendor_id\\":2338,\\"product_id\\":32772}],\\"urls\\":[\\"${origin}\\"]}]"`,
  ].join("\n");

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }

  return (
    <Card>
      <details>
        <summary className="cursor-pointer text-base font-semibold tracking-tight text-foreground">Setting up this PC</summary>
        <ol className="mt-3 flex list-decimal flex-col gap-3 pl-5 text-sm text-foreground">
          <li>
            Plug the DYMO scale and the Rollo into this PC with USB. Use the Rollo on USB, not Wi-Fi: it&apos;s faster
            and doesn&apos;t drop off the network.
          </li>
          <li>
            Make the Rollo the Windows default printer (Settings, Printers &amp; scanners; turn off &quot;Let Windows
            manage my default printer&quot;). In the Rollo&apos;s Printing preferences, set the paper size to 2 x 1 in.
          </li>
          <li>
            So labels print with no pop-up, make a desktop shortcut: right-click the desktop, New, Shortcut, and paste
            this as the location:
            <div className="mt-2 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 text-xs">{shortcut}</code>
              <Button variant="outline" size="sm" onClick={() => copy("shortcut", shortcut)} className="shrink-0">
                <Copy className="size-4" aria-hidden />
                {copied === "shortcut" ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Close every Chrome window before opening the shortcut. Chrome ignores --kiosk-printing if it&apos;s
              already running.
            </p>
          </li>
          <li>Open the shortcut, sign in, press Connect scale and pick the DYMO. Then press Test print.</li>
          <li>
            Leave this window open. It&apos;s fine behind other windows. The scale and printer only work in Chrome or
            Edge on a computer.
          </li>
          <li>
            If you have to press Connect scale again every time the scale turns off, Chrome is forgetting it. Save this
            as a .reg file, double-click it, then restart Chrome:
            <div className="mt-2 flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">{policy}</pre>
              <Button variant="outline" size="sm" onClick={() => copy("policy", policy)} className="shrink-0">
                <Copy className="size-4" aria-hidden />
                {copied === "policy" ? "Copied" : "Copy"}
              </Button>
            </div>
          </li>
        </ol>
      </details>
    </Card>
  );
}
