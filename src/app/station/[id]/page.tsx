"use client";

import { LabelPreview } from "@/components/labels/LabelPreview";
import { isLabelKind, itemMetaLine } from "@/components/labels/labelMarkup";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { logout, useCurrentUser } from "@/components/UserNav";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import { printLabels, printPage } from "@/lib/warehouse/labelPrint";
import { dudBoxName } from "@/lib/warehouse/codes";
import type { DudBoxSummary } from "@/lib/warehouse/dudBoxTypes";
import { formatOunces, formatPoundsOunces, scaleStatusMessage, type ScaleStatus } from "@/lib/warehouse/scale";
import { DEFAULT_CHROME_PATH, stationPolicyRegFile, stationShortcutArgs } from "@/lib/warehouse/stationSetup";
import type { PrintJobRow } from "@/lib/warehouse/stations";
import {
  DEFAULT_LABEL_SIZE,
  LABEL_SIZES,
  helperCanPrintLabels,
  isPageKind,
  type CodeLabelPayload,
  type ItemLabelPayload,
  type LabelSize,
  type PageJobPayload,
  type PrintJobKind,
  type PrintJobPayload,
  type StationStatus,
} from "@/lib/warehouse/types";
import { Copy, Download, LogOut, PackageMinus, Power, Printer, QrCode, RefreshCw, RotateCcw, Scale, Usb } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useScale, type ScaleState } from "./useScale";
import { useTicker } from "./useTicker";

// The page left open full-screen on a listing station PC. It does three
// jobs, all on its own once it's set up:
//   1. Reads the USB scale (useScale) and reports the weight to the server
//      (heartbeat), where the lister's handheld picks it up. With the print
//      helper on this PC, the helper reads the scale over USB and reports
//      it itself (StationStatus.helperScale; Cristian, 2026-10-25: Chrome
//      wouldn't pick the DYMO back up after it powered off); this page
//      then only shows the helper's reading and leaves the scale alone.
//   2. Checks for queued labels and prints them on the Rollo. With the
//      print helper installed on this PC and a printer picked (Printer
//      card), the helper prints the 4x6 pages on that printer and this page
//      only the small code labels (Cristian, 2026-10-21).
//   3. Shows what's going on, with a print log and Reprint buttons.
//
// Timing (all driven by one 250ms worker tick, see useTicker). One call,
// the heartbeat, does it all: sends the weight, takes waiting labels, and
// brings back the station's settings and print helper status (Cristian,
// 2026-11-01: it was three calls on their own timers, a big part of the
// Vercel bill). Sent:
//   right after the weight changes, at most 4 a second;
//   otherwise, while this page prints labels: every 1.5s if anything
//     happened in the last 2 minutes (a label printed, the weight moved,
//     the mouse), every 5s if not;
//   while the print helper prints everything: every 10s, or every second
//     while someone's weighing on the helper's scale (this page shows its
//     weight from the heartbeat's answer).
// The print log is re-read after this page prints, and every 15s (60s
// when quiet) for what the helper printed.
// After an hour with nobody doing anything here, a station sign-in ends
// and the PC goes back to its sign-in screen (src/lib/stationIdle.ts);
// anyone else's page just goes to sleep until someone touches it.

const TICK_MS = 250;
const HEARTBEAT_MIN_GAP_MS = 250;
const HEARTBEAT_RETRY_MS = 2_000;
const BEAT_ACTIVE_MS = 1_500;
const BEAT_IDLE_MS = 5_000;
const BEAT_HELPER_MS = 10_000;
const HELPER_SCALE_ACTIVE_MS = 1_000;
const LOG_ACTIVE_MS = 15_000;
const LOG_IDLE_MS = 60_000;
const ACTIVE_WINDOW_MS = 2 * 60_000;
// A weight change at least this big counts as someone working here.
const ACTIVITY_OZ = 0.2;

// Two short beeps when the scale turns itself off, so whoever's weighing
// presses its power button before the next item instead of after. Chrome
// only lets a page make sound once someone has clicked on it since it
// loaded (or with --autoplay-policy=no-user-gesture-required, which the
// station shortcut has); otherwise this stays silent and the big card on
// screen still says it.
let beepAudio: AudioContext | null = null;
function beepScaleOff() {
  try {
    beepAudio ??= new AudioContext();
    const ctx = beepAudio;
    if (ctx.state === "suspended") void ctx.resume();
    [0, 0.25].forEach((at) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.2);
    });
  } catch {
    // No audio on this PC: the card is enough.
  }
}

type ServerState = "connecting" | "online" | "offline" | "signed-out" | "deleted" | "asleep";

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
  const [station, setStation] = useState<StationStatus | null>(null);
  // Chrome only reads the scale when the helper doesn't (and not before the
  // station has loaded, so it doesn't grab it for a moment first).
  const helperScale = station?.helperScale ?? false;
  const webScale = useScale(station != null && !helperScale);
  const scale: ScaleState =
    helperScale && station
      ? {
          connection: station.scaleStatus === "off" ? "off" : "connected",
          deviceName: "DYMO scale (read by the print helper)",
          reading:
            station.scaleStatus === "off"
              ? null
              : { status: (station.scaleStatus ?? "zero") as ScaleStatus, weightOz: station.weightOz, stable: station.weightStable },
          lastReportAt: null,
          error: null,
          connect: webScale.connect,
        }
      : webScale;
  const helperScaleRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [server, setServer] = useState<ServerState>("connecting");
  const [log, setLog] = useState<PrintJobRow[] | null>(null);
  const [nowPrinting, setNowPrinting] = useState<QueuedJob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [pollActive, setPollActive] = useState(true);
  // Off: nothing prints, jobs wait in the queue until it's back on. For
  // swapping paper, or switching the default printer to print something
  // else (Cristian, 2026-10-19: a scan form on the regular printer).
  const [autoPrint, setAutoPrint] = useState(true);
  const autoPrintRef = useRef(true);
  // A printer is picked for the 4x6 pages / small labels, so the print
  // helper prints those and this page leaves them alone, even while the
  // helper looks offline (StationStatus.helperTakesPages). labelSizeRef:
  // the stock this page prints small labels on.
  const helperPagesRef = useRef(false);
  const helperLabelsRef = useRef(false);
  const labelSizeRef = useRef<LabelSize>(DEFAULT_LABEL_SIZE);
  // This PC shows a QR code for the next person after a log out
  // (ScannerSignInCard; src/lib/stationSignIn.ts).
  const [scannerSignIn, setScannerSignIn] = useState<{ thisStation: boolean; otherStation: string | null } | null>(null);
  const scannerSignInRef = useRef(false);
  const user = useCurrentUser();

  const weightOz = scale.connection === "connected" ? (scale.reading?.weightOz ?? null) : null;
  const stable = weightOz !== null && Boolean(scale.reading?.stable);

  // Beep on the change from on to off, not when the page opens to a scale
  // that's already off.
  const prevConnection = useRef(scale.connection);
  useEffect(() => {
    if (prevConnection.current === "connected" && scale.connection === "off") beepScaleOff();
    prevConnection.current = scale.connection;
  }, [scale.connection]);

  // Latest values for the tick, which runs outside React's render cycle.
  const readingRef = useRef({ weightOz, stable });
  const hb = useRef({ sentKey: "", sentAt: 0, inFlight: false });
  // Printing what a heartbeat brought back: the next ones don't take more
  // until it's done.
  const printing = useRef(false);
  const logLoadedAt = useRef(0);
  // Set on mount so a freshly opened page starts out checking quickly.
  const lastActivityAt = useRef(0);
  // Anyone doing anything here (mouse, keys, scale, a label), for the
  // hour-idle sign-out. The server can move it later (activeAt): a label
  // queued from a handheld counts too.
  const lastInputAt = useRef(0);
  const asleep = useRef(false);
  const lastWeight = useRef<number | null>(null);
  const halted = useRef(false);

  useEffect(() => {
    readingRef.current = { weightOz, stable };
    if (weightOz !== null && (lastWeight.current === null || Math.abs(weightOz - lastWeight.current) >= ACTIVITY_OZ)) {
      lastActivityAt.current = Date.now();
      lastInputAt.current = Date.now();
    }
    lastWeight.current = weightOz;
  }, [weightOz, stable]);

  // Mouse or keys on this PC: someone's here. Wakes a sleeping page.
  useEffect(() => {
    let last = 0;
    function touched() {
      const t = Date.now();
      // pointermove fires constantly; once a second is plenty.
      if (t - last < 1000) return;
      last = t;
      lastInputAt.current = t;
      lastActivityAt.current = t;
      if (asleep.current) {
        asleep.current = false;
        hb.current.sentAt = 0;
        logLoadedAt.current = 0;
        setServer("connecting");
      }
    }
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, touched, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, touched);
    };
  }, []);

  function handleStatus(status: number) {
    if (status === 401) {
      halted.current = true;
      setServer("signed-out");
      // Reloading signed out lands a PC set up for scanner sign-in on its
      // QR screen (proxy.ts) for the next person; any other PC on the
      // password form, which brings it back here.
      if (scannerSignInRef.current) window.location.reload();
    } else if (status === 404) {
      halted.current = true;
      setServer("deleted");
    } else {
      setServer("offline");
    }
  }

  async function loadLog() {
    logLoadedAt.current = Date.now();
    try {
      const res = await fetch(`/api/stations/${id}/log?limit=25`, { cache: "no-store" });
      if (res.ok) setLog(await res.json());
    } catch {
      // The next print or reload tries again.
    }
  }

  // Print automatically is kept on the server (Station.printPaused), so
  // the print helper pauses with the page.
  function applyStation(data: StationStatus) {
    setStation(data);
    autoPrintRef.current = !data.printPaused;
    setAutoPrint(!data.printPaused);
    helperPagesRef.current = data.helperTakesPages;
    helperLabelsRef.current = data.helperTakesLabels;
    helperScaleRef.current = data.helperScale;
    labelSizeRef.current = data.labelSize;
  }

  async function loadStation(first = false) {
    try {
      const r = await fetch(`/api/stations/${id}`, { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Couldn't load this station.");
      applyStation(data as StationStatus);
    } catch (e) {
      if (first) setLoadError(e instanceof Error ? e.message : "Couldn't load this station.");
    }
  }

  async function patchStation(body: Record<string, unknown>): Promise<boolean> {
    setMessage(null);
    try {
      const res = await fetch(`/api/stations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't change that.");
      applyStation(data as StationStatus);
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't change that.");
      return false;
    }
  }

  async function changeAutoPrint(on: boolean) {
    autoPrintRef.current = on;
    setAutoPrint(on);
    if (!(await patchStation({ printPaused: !on }))) {
      autoPrintRef.current = !on;
      setAutoPrint(!on);
      return;
    }
    if (on) {
      lastActivityAt.current = Date.now();
      hb.current.sentAt = 0; // print what's waiting right away
    }
  }

  useEffect(() => {
    lastActivityAt.current = Date.now();
    lastInputAt.current = Date.now();
    // Both set state only after their fetch comes back.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStation(true);
    loadLog();
    void deviceRequest("GET");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function deviceRequest(method: "GET" | "POST" | "DELETE") {
    try {
      const res = await fetch(`/api/stations/${id}/device`, { method, cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      scannerSignInRef.current = data.thisStation;
      setScannerSignIn(data);
    } catch {
      // Card stays as it was; try again with its button.
    }
  }

  // What this page takes from the queue: whatever no helper printer is
  // picked for. Nothing while printing is paused, or still printing the
  // last batch.
  function claimKinds(): "all" | "page" | "label" | undefined {
    if (!autoPrintRef.current || printing.current) return undefined;
    const pages = !helperPagesRef.current;
    const labels = !helperLabelsRef.current;
    return pages && labels ? "all" : pages ? "page" : labels ? "label" : undefined;
  }

  async function sendHeartbeat(key: string, reading: { weightOz: number | null; stable: boolean }) {
    const state = hb.current;
    state.inFlight = true;
    state.sentKey = key;
    state.sentAt = Date.now();
    try {
      const res = await fetch(`/api/stations/${id}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The helper's weight isn't this page's to send.
          ...(helperScaleRef.current ? {} : reading),
          claim: claimKinds(),
          idleMs: Date.now() - lastInputAt.current,
        }),
      });
      if (!res.ok) {
        handleStatus(res.status);
        state.sentAt = Date.now() - BEAT_HELPER_MS + HEARTBEAT_RETRY_MS;
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.idle) {
        // Not a station sign-in, so nobody's signed out: the page just
        // stops calling the app until someone moves the mouse.
        asleep.current = true;
        setServer("asleep");
        return;
      }
      setServer("online");
      if (typeof data?.activeAt === "number") lastInputAt.current = Math.max(lastInputAt.current, data.activeAt);
      if (data?.station) applyStation(data.station as StationStatus);
      const jobs: QueuedJob[] = Array.isArray(data?.jobs) ? data.jobs : [];
      if (jobs.length) void printJobs(jobs);
    } catch {
      setServer("offline");
      state.sentAt = Date.now() - BEAT_HELPER_MS + HEARTBEAT_RETRY_MS;
    } finally {
      state.inFlight = false;
    }
  }

  async function printJobs(jobs: QueuedJob[]) {
    printing.current = true;
    try {
      lastActivityAt.current = Date.now();
      for (const job of jobs) await printJob(job);
      lastActivityAt.current = Date.now();
      lastInputAt.current = Date.now();
      await loadLog();
    } finally {
      printing.current = false;
      // Check again right away: there may be more waiting.
      hb.current.sentAt = 0;
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
        await printLabels(job.kind, job.payload, job.copies, labelSizeRef.current);
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

  useTicker(TICK_MS, () => {
    if (halted.current || asleep.current) return;
    const t = Date.now();

    const active = t - lastActivityAt.current < ACTIVE_WINDOW_MS;
    setPollActive(active);
    const pageClaims = autoPrintRef.current && (!helperPagesRef.current || !helperLabelsRef.current);
    let every = pageClaims ? (active ? BEAT_ACTIVE_MS : BEAT_IDLE_MS) : BEAT_HELPER_MS;
    // The weight on screen comes from the helper's readings, through the
    // heartbeat's answer.
    if (helperScaleRef.current) every = Math.min(every, active ? HELPER_SCALE_ACTIVE_MS : BEAT_IDLE_MS);

    const reading = readingRef.current;
    const key = helperScaleRef.current ? "helper" : `${reading.weightOz}|${reading.stable}`;
    const h = hb.current;
    if (!h.inFlight && ((key !== h.sentKey && t - h.sentAt >= HEARTBEAT_MIN_GAP_MS) || t - h.sentAt >= every)) {
      void sendHeartbeat(key, reading);
    }

    // What the print helper printed, and the Waiting rows while paused.
    if (!printing.current && t - logLoadedAt.current >= (active ? LOG_ACTIVE_MS : LOG_IDLE_MS)) void loadLog();

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
      hb.current.sentAt = 0; // check right away
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
    await patchStation({ packingSlips: on });
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
      hb.current.sentAt = 0;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Couldn't reprint.");
    }
  }

  const latest = log?.find((j) => isLabelKind(j.kind));
  const waiting = log?.filter((j) => j.status === "queued").length ?? 0;
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
    <AppShell
      width="wide"
      title={station?.name ?? "Station"}
      subtitle="Leave this page open on the station PC."
      actions={
        scannerSignIn?.thisStation && user ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              Signed in: <span className="font-semibold text-foreground">{user.username}</span>
            </span>
            <Button size="lg" variant="outline" onClick={logout}>
              <LogOut className="size-5" aria-hidden />
              Log out
            </Button>
          </div>
        ) : undefined
      }
    >
      {server === "signed-out" && (
        <Alert tone="danger" title="Signed out" className="mb-4">
          This PC got signed out, so weights and labels stopped. Reload the page and sign in again.
        </Alert>
      )}
      {server === "asleep" && (
        <Alert tone="warning" title="Asleep" className="mb-4">
          Nobody&apos;s used this station for an hour, so it stopped checking for labels and weights. Move the mouse or
          press a key to wake it.
        </Alert>
      )}
      {server === "deleted" && (
        <Alert tone="danger" title="This station was deleted" className="mb-4">
          Pick another station from the Station page.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <ScaleCard scale={scale} weightOz={weightOz} stable={stable} now={now} scalePolicy={station?.scalePolicy ?? null} viaHelper={helperScale} />

          {/* Right under the scale: the station PC window is usually narrow,
              so the right column ends up far down the page. */}
          <ListingDudBoxCard
            stationId={id}
            disabled={stopped}
            onQueued={() => {
              lastActivityAt.current = Date.now();
              hb.current.sentAt = 0; // check right away
            }}
          />

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
                checked={autoPrint}
                disabled={stopped}
                onChange={(e) => changeAutoPrint(e.target.checked)}
              />
              <span>
                Print automatically
                <span className="block text-xs text-muted-foreground">
                  Turn off to swap paper or print something else on another printer. Labels and packing slips wait here
                  and print when you turn it back on.
                </span>
              </span>
            </label>
            {!autoPrint && (
              <Alert
                tone="warning"
                title="Printing is paused"
                className="mb-3"
                action={
                  <Button size="sm" onClick={() => changeAutoPrint(true)}>
                    <Printer className="size-4" aria-hidden />
                    Turn printing back on
                  </Button>
                }
              >
                {waiting > 0
                  ? `${waiting} waiting to print. They print as soon as it's back on.`
                  : "Nothing's waiting. Anything sent here waits until it's back on."}
              </Alert>
            )}
            {station && (station.helperTakesPages || station.helperTakesLabels) && !station.helperOnline && (
              <Alert tone="danger" title="The print helper isn't running" className="mb-3">
                {[station.helperTakesLabels && "Small labels", station.helperTakesPages && "4x6 labels"].filter(Boolean).join(" and ")}{" "}
                wait here until it&apos;s back, so they don&apos;t come out on the wrong printer. Restart this PC or
                reinstall the print helper (Printers card). To print them on the Windows default printer instead, set the
                printer there to the Windows default option.
              </Alert>
            )}
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
                <LabelPreview
                  kind={latest.kind as PrintJobKind}
                  payload={latest.payload as PrintJobPayload}
                  scale={1.5}
                  size={station?.labelSize}
                />
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
                          : server === "asleep"
                            ? "Asleep. Move the mouse to wake it."
                            : "Station deleted"
                }
              />
              <StatusRow
                ok={scale.connection === "connected"}
                label="Scale"
                text={scale.connection === "connected" ? (scale.deviceName ?? "Connected") : scaleConnectionText(scale.connection)}
              />
              <StatusRow
                ok={server === "online" && autoPrint}
                label="Printer"
                text={
                !autoPrint
                  ? "Paused. Labels wait until printing is back on."
                  : station?.helperTakesPages || station?.helperTakesLabels
                    ? [
                        `4x6 labels: ${station.helperTakesPages ? `${station.printerName} (print helper)` : "this page"}.`,
                        `Small labels: ${station.helperTakesLabels ? `${station.labelPrinterName} (print helper)` : "this page"}.`,
                      ].join(" ")
                    : `Checking for labels every ${(pollActive ? BEAT_ACTIVE_MS : BEAT_IDLE_MS) / 1000}s`
              }
              />
            </ul>
          </Card>
          {station && (
            <PrinterCard station={station} onChange={patchStation} disabled={stopped} isOwner={user?.role === "owner"} />
          )}
          {user?.role === "owner" && <ScannerSignInCard state={scannerSignIn} onChange={deviceRequest} />}
          {/* Setting up a station PC is the owner's job (Cristian, 2026-10-26). */}
          {user?.role === "owner" && <SetupHelp stationId={id} />}
        </div>
      </div>
    </AppShell>
  );
}

// The listing table's dud box for set-asides (Cristian, 2026-11-06): the
// pack card's "Set aside" puts units in the load's open listing dud box
// (DudBox.forListing), never a sorter's (those are stacked away). Here, at
// the PC with the printer, they start one for the load being listed, start
// the next when it's full (the full one closes), and reprint its label.
// The load defaults to the one this station last printed item labels for.
// Only on the Listing Station (Cristian, 2026-11-06); hidden elsewhere.
function ListingDudBoxCard({
  stationId,
  disabled,
  onQueued,
}: {
  stationId: string;
  disabled: boolean;
  onQueued: () => void;
}) {
  const [loads, setLoads] = useState<{ id: string; title: string }[] | null>(null);
  const [manifestId, setManifestId] = useState<string | null>(null);
  const [box, setBox] = useState<DudBoxSummary | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmNext, setConfirmNext] = useState(false);
  const [listingStation, setListingStation] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, current] = await Promise.all([
        fetch("/api/manifests", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []),
        fetch(`/api/stations/${stationId}/listing-load`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (cancelled) return;
      if (!current?.listingStation) return;
      setListingStation(true);
      const options = (Array.isArray(list) ? list : []).map((m: { id: string; title: string }) => ({
        id: m.id,
        title: m.title,
      }));
      setLoads(options);
      setManifestId(current?.manifestId ?? options[0]?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [stationId]);

  async function loadBox(forManifest: string | null) {
    if (!forManifest) return setBox(null);
    const params = new URLSearchParams({ status: "open", forListing: "1", manifestId: forManifest });
    const data = await fetch(`/api/dud-boxes?${params}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    setBox((data?.boxes as DudBoxSummary[] | undefined)?.[0] ?? null);
  }

  useEffect(() => {
    if (!manifestId) return;
    let cancelled = false;
    const params = new URLSearchParams({ status: "open", forListing: "1", manifestId });
    fetch(`/api/dud-boxes?${params}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => {
        if (!cancelled) setBox((data?.boxes as DudBoxSummary[] | undefined)?.[0] ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [manifestId]);

  function pickLoad(id: string | null) {
    setBox(undefined);
    setMessage(null);
    setConfirmNext(false);
    setManifestId(id);
  }

  async function startBox() {
    if (!manifestId) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch("/api/dud-boxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestId, stationId, forListing: true, replaces: box?.code ?? null }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.box) {
        // 409: another screen started one, show the box on the table now.
        if (r.status === 409) await loadBox(manifestId);
        throw new Error(data?.error ?? "Couldn't start a dud box.");
      }
      onQueued();
      const closed = box ? ` ${dudBoxName(box.code)} is closed, set it aside for processing.` : "";
      setMessage(
        data.printed
          ? { ok: true, text: `${dudBoxName(data.box.code)} started, its label is printing.${closed}` }
          : {
              ok: false,
              text: `${dudBoxName(data.box.code)} started, but its label didn't print: ${data.printError ?? "unknown error"}.${closed}`,
            }
      );
      setConfirmNext(false);
      await loadBox(manifestId);
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // Close it without starting another (done with this load, say). The next
  // set-aside then asks for a new box.
  async function closeBox() {
    if (!box || !manifestId) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch(`/api/dud-boxes/${encodeURIComponent(box.code)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed" }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error ?? "Couldn't close the box.");
      setMessage({ ok: true, text: `${dudBoxName(box.code)} closed. Set it aside for processing.` });
      setConfirmNext(false);
      await loadBox(manifestId);
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function reprint() {
    if (!box) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch(`/api/dud-boxes/${encodeURIComponent(box.code)}/print`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stationId }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error ?? "Couldn't reprint the label.");
      onQueued();
      setMessage({ ok: true, text: `${dudBoxName(box.code)} label is printing.` });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!listingStation) return null;

  return (
    <Card>
      <SectionHeader
        title="Dud boxes"
        description="Where the listing table's set-asides go. Labels print here."
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadBox(manifestId)}
            disabled={busy || !manifestId}
            aria-label="Refresh"
          >
            <RefreshCw className="size-4" aria-hidden />
          </Button>
        }
      />
      {loads === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : loads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bought loads yet.</p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Load</span>
            <Select
              value={manifestId ?? ""}
              onChange={(e) => pickLoad(e.target.value || null)}
              disabled={busy || disabled}
              aria-label="Load"
            >
              {loads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </Select>
          </label>
          {box === undefined ? (
            <p className="text-muted-foreground">Finding this load&apos;s dud box…</p>
          ) : box === null ? (
            <>
              <p className="text-foreground">No dud box at the listing table for this load yet.</p>
              <div>
                <Button size="sm" onClick={startBox} disabled={busy || disabled}>
                  <PackageMinus className="size-4" aria-hidden />
                  Start a dud box
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-foreground">
                <span className="font-semibold">{dudBoxName(box.code)}</span>{" "}
                <span className="text-muted-foreground">
                  · {box.units} {box.units === 1 ? "unit" : "units"} in it
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={reprint} disabled={busy || disabled}>
                  <Printer className="size-4" aria-hidden />
                  Reprint label
                </Button>
                {confirmNext ? (
                  <>
                    <Button size="sm" onClick={startBox} disabled={busy || disabled}>
                      Close it, start the next
                    </Button>
                    <Button variant="outline" size="sm" onClick={closeBox} disabled={busy || disabled}>
                      Just close it
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmNext(false)} disabled={busy}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setConfirmNext(true)} disabled={busy || disabled}>
                    <PackageMinus className="size-4" aria-hidden />
                    Close this box
                  </Button>
                )}
              </div>
            </>
          )}
          {message && <p className={message.ok ? "text-green-700" : "text-red-700"}>{message.text}</p>}
        </div>
      )}
    </Card>
  );
}

// Where this station's labels print and on what stock. Chrome can only
// print on this PC's default printer and drifts to the last one it used,
// so the print helper (installed from here) prints on the printers picked
// below instead: one for the 4x6 pages (shipping labels, packing slips,
// delivery labels), one for the small code labels. The label size applies
// either way (Cristian, 2026-10-24: bin labels on 2.25" x 1.25").
function PrinterCard({
  station,
  onChange,
  disabled,
  isOwner,
}: {
  station: StationStatus;
  onChange: (body: Record<string, unknown>) => Promise<boolean>;
  disabled: boolean;
  // Installing / reinstalling the print helper is owner only.
  isOwner: boolean;
}) {
  const installer = `/api/stations/${station.id}/print-helper`;
  const installed = station.helperInstalled;
  const seen = station.helperSeenAt ? new Date(station.helperSeenAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  const canPrintLabels = helperCanPrintLabels(station.helperVersion);
  const latest = useLatestHelperVersion(station.helperVersion);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const wasPending = useRef(false);

  // The helper picks the request up on its next check-in (about 10s) and
  // restarts if there was an update; the next station refresh shows it.
  useEffect(() => {
    if (wasPending.current && !station.helperUpdatePending) {
      setChecking(false);
      setCheckNote(`Checked. The helper is on version ${station.helperVersion ?? "?"}.`);
    }
    wasPending.current = station.helperUpdatePending;
  }, [station.helperUpdatePending, station.helperVersion]);

  async function checkForUpdates() {
    setCheckNote(null);
    setChecking(true);
    if (!(await onChange({ checkForUpdate: true }))) setChecking(false);
  }

  const printerOptions = (picked: string | null, none: string) => (
    <>
      <option value="">{none}</option>
      {station.printers.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
      {picked && !station.printers.includes(picked) && <option value={picked}>{picked} (not on this PC anymore)</option>}
    </>
  );

  const sizeName = LABEL_SIZES[station.labelSize].name;

  return (
    <Card>
      <SectionHeader title="Printers" description="Where this station's labels print, and on what size labels." />
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-2">
          <p className="font-medium text-foreground">Small labels</p>
          <p className="text-xs text-muted-foreground">Item, bin, shelf and box labels.</p>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Label size
            <Select
              value={station.labelSize}
              disabled={disabled}
              onChange={(e) => void onChange({ labelSize: e.target.value })}
              aria-label="Label size"
            >
              {(Object.keys(LABEL_SIZES) as LabelSize[]).map((s) => (
                <option key={s} value={s}>
                  {LABEL_SIZES[s].name}
                </option>
              ))}
            </Select>
          </label>
          {installed && canPrintLabels && (
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Printer
              <Select
                value={station.labelPrinterName ?? ""}
                disabled={disabled}
                onChange={(e) => void onChange({ labelPrinterName: e.target.value || null })}
                aria-label="Printer for small labels"
              >
                {printerOptions(station.labelPrinterName, "Windows default printer (this page prints them)")}
              </Select>
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            {station.labelPrinterName && canPrintLabels
              ? `They print on ${station.labelPrinterName} at ${sizeName}, whatever the Windows default is. If they come out the wrong size, set ${sizeName} as the paper size in that printer's Printing preferences.`
              : `They print on this PC's Windows default printer at ${sizeName}. Set ${sizeName} as the paper size in that printer's Printing preferences too.`}
          </p>
          {installed && !canPrintLabels && (
            <p className="text-xs text-muted-foreground">
              To pick a separate printer for these, the print helper needs updating:{" "}
              <a href={installer} className="font-medium text-primary underline">
                reinstall it
              </a>{" "}
              once.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className="font-medium text-foreground">4x6 labels</p>
          <p className="text-xs text-muted-foreground">Shipping labels, packing slips and delivery labels.</p>
          {installed && (
            <Select
              value={station.printerName ?? ""}
              disabled={disabled}
              onChange={(e) => void onChange({ printerName: e.target.value || null })}
              aria-label="Printer for 4x6 labels"
            >
              {printerOptions(station.printerName, "Don't use the helper (Windows default printer)")}
            </Select>
          )}
          <p className="text-xs text-muted-foreground">
            {!installed
              ? "Right now these print on this PC's Windows default printer."
              : station.printerName
                ? "4x6 labels print there no matter what the Windows default is."
                : "Pick the 4x6 printer. Until then, they print on the Windows default."}
          </p>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          {!installed && !isOwner ? (
            <p className="text-foreground">The print helper isn&apos;t installed on this PC. Ask the owner to set it up.</p>
          ) : !installed ? (
            <>
              <p className="text-foreground">
                To pick the printers here instead of using the Windows default, install the print helper on this PC.
                One file sets up everything it needs.
              </p>
              <a href={installer} className={buttonClasses({ variant: "primary", size: "md" })}>
                <Download className="size-4" aria-hidden />
                Download installer
              </a>
              <ol className="list-decimal pl-5 text-xs text-muted-foreground">
                <li>Open the file you just downloaded. If Chrome warns about it, choose Keep.</li>
                <li>If Windows says it protected your PC, click More info, then Run anyway.</li>
                <li>Wait for &quot;Done&quot; (the first time can take a couple of minutes), then pick the printers here.</li>
              </ol>
            </>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                <StatusRow
                  ok={station.helperOnline}
                  label="Print helper"
                  text={
                    station.helperOnline
                      ? `Running on this PC${station.helperVersion ? ` (version ${station.helperVersion})` : ""}`
                      : seen
                        ? `Not running. Last seen ${seen}. ${isOwner ? "Restart the PC or reinstall." : "Restart the PC, or tell the owner."}`
                        : isOwner
                          ? "Installed, but it never started on this PC. Reinstall it and check the installer window."
                          : "Installed, but it never started on this PC. Tell the owner."
                  }
                />
              </ul>
              {!station.helperOnline && station.helperError && (
                <div className="rounded-lg border border-border bg-muted/40 p-2 text-xs">
                  <p className="font-medium text-foreground">
                    Why it stopped
                    {station.helperErrorAt
                      ? ` (${new Date(station.helperErrorAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})`
                      : ""}
                    :
                  </p>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
                    {station.helperError}
                  </pre>
                </div>
              )}
              {canPrintLabels ? (
                <div className="flex flex-col gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={checkForUpdates}
                    disabled={disabled || checking || station.helperUpdatePending || !station.helperOnline}
                  >
                    <RefreshCw className={checking || station.helperUpdatePending ? "size-4 animate-spin" : "size-4"} aria-hidden />
                    {checking || station.helperUpdatePending ? "Checking for updates…" : "Check for updates"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {checkNote ??
                      (latest && station.helperVersion && latest > station.helperVersion
                        ? `Version ${latest} is out. Press Check for updates to get it now.`
                        : "It also updates itself every 6 hours.")}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This version can&apos;t update on request yet. Reinstall once and it gets a Check for updates button.
                </p>
              )}
              {isOwner && (
                <a href={installer} className="text-xs font-medium text-primary underline">
                  Reinstall the print helper
                </a>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

// The helper version the app is handing out right now, read from the
// helper file itself (its VERSION line), so "an update is out" can't drift
// from the real file. Re-read when the running version changes.
function useLatestHelperVersion(running: string | null): string | null {
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/print-helper/print_helper.py?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => {
        const m = /^VERSION = "([^"]+)"/m.exec(text);
        if (!cancelled && m) setLatest(m[1]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [running]);
  return latest;
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
  scalePolicy,
  viaHelper,
}: {
  scale: ReturnType<typeof useScale>;
  weightOz: number | null;
  stable: boolean;
  now: number;
  scalePolicy: string | null;
  viaHelper: boolean;
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
        <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-8 text-center text-amber-950">
          <Power className="size-14 text-amber-600" aria-hidden />
          <p className="text-3xl font-bold tracking-tight sm:text-4xl">Scale is off</p>
          <p className="text-lg font-medium">Press the power button on the scale.</p>
          <p className="max-w-sm text-sm">
            It turns itself off after 3 idle minutes, and that can&apos;t be changed. It shows up here again on its
            own once it&apos;s on.
          </p>
          {!viaHelper && (
            <Button variant="outline" size="sm" onClick={scale.connect}>
              <Usb className="size-4" aria-hidden />
              Still not working? Connect scale
            </Button>
          )}
        </div>
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
      {!viaHelper && scale.connection !== "connected" && scale.connection !== "unsupported" && (scalePolicy === "missing" || scalePolicy === "other-site") && (
        <Alert tone="warning" title="This PC isn't set to remember the scale" className="mt-3">
          The DYMO has no serial number, so Chrome forgets it every time Chrome restarts or the scale blinks off USB.
          {scalePolicy === "other-site" ? " The setting on this PC is for a different web address." : ""} Reinstall the
          print helper (Printers card) and click Yes when Windows asks for permission, then close every Chrome window
          and reopen the station shortcut.
        </Alert>
      )}
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

// Scanner sign-in on this PC (Cristian, 2026-10-26; src/lib/stationSignIn.ts):
// on, Log out shows a QR code, and the next person scans it with their own
// handheld and types their PIN there instead of a password here. Per PC
// (a cookie), so his own PC opening this page isn't affected. Owner only.
function ScannerSignInCard({
  state,
  onChange,
}: {
  state: { thisStation: boolean; otherStation: string | null } | null;
  onChange: (method: "POST" | "DELETE") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function run(method: "POST" | "DELETE") {
    setBusy(true);
    try {
      await onChange(method);
    } finally {
      setBusy(false);
    }
  }
  if (!state) return null;
  return (
    <Card>
      <SectionHeader
        title="Scanner sign-in"
        description={
          state.thisStation
            ? "On for this PC. Log out (top right) shows a QR code; the next person scans it with their scanner and types their PIN."
            : "Let people sign in here by scanning a QR code with their own scanner and typing their PIN, instead of a password. Turn it on from the station PC itself."
        }
      />
      {state.otherStation && !state.thisStation && (
        <p className="mb-3 text-sm text-foreground">This PC is set up as {state.otherStation} now. Turning it on here moves it to this station.</p>
      )}
      {state.thisStation ? (
        <Button variant="ghost" size="sm" onClick={() => run("DELETE")} disabled={busy}>
          Turn off on this PC
        </Button>
      ) : (
        <Button size="sm" onClick={() => run("POST")} disabled={busy}>
          <QrCode className="size-4" aria-hidden />
          Turn on for this PC
        </Button>
      )}
    </Card>
  );
}

// One-time setup for a station PC. Shown on the page itself because that's
// where you are when you're setting one up.
function SetupHelp({ stationId }: { stationId: string }) {
  const [origin, setOrigin] = useState("https://www.epicsteals.dev");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    // window only exists in the browser, after the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
  }, []);

  // Shared with the print helper installer, which does these steps itself.
  const shortcut = `"${DEFAULT_CHROME_PATH}" ${stationShortcutArgs(origin, stationId)}`;
  const policy = stationPolicyRegFile(origin);

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
        <p className="mt-3 text-sm text-foreground">
          Easiest: plug in the scale and the Rollo, then use <span className="font-medium">Download installer</span> in
          the Printers card. It does steps 3 and 4 below by itself (the Chrome settings and a desktop shortcut named after
          this station), turns off &quot;Let Windows manage my default printer&quot;, and sets up the print helper. You
          still pick the Windows default printer in step 2. These steps are for doing it all by hand.
        </p>
        <ol className="mt-3 flex list-decimal flex-col gap-3 pl-5 text-sm text-foreground">
          <li>
            Plug the DYMO scale and the Rollo into this PC with USB. Use the Rollo on USB, not Wi-Fi: it&apos;s faster
            and doesn&apos;t drop off the network.
          </li>
          <li>
            Make the Rollo the Windows default printer (Settings, Printers &amp; scanners; turn off &quot;Let Windows
            manage my default printer&quot;). In the Rollo&apos;s Printing preferences, set the paper size to the label size picked in the Printers card
            (2 x 1 in unless you changed it).
          </li>
          <li>
            So Chrome always prints labels on the default printer (not the last printer it used), save this as a .reg
            file, double-click it, and say Yes. It also stops Chrome forgetting the scale.
            <div className="mt-2 flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">{policy}</pre>
              <Button variant="outline" size="sm" onClick={() => copy("policy", policy)} className="shrink-0">
                <Copy className="size-4" aria-hidden />
                {copied === "policy" ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Then close every Chrome window so it takes effect. In your normal Chrome the print dialog will start on
              the label printer: for a scan form, pick the regular printer there. Don&apos;t switch the Windows default
              to print something else.
            </p>
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
              This opens a separate Chrome just for the station, so only it prints with no pop-up. Your normal Chrome
              keeps the regular print dialog, so print scan forms and anything else from there and pick the printer.
              The first time, sign in and connect the scale again in the new window.
            </p>
          </li>
          <li>Open the shortcut, sign in, press Connect scale and pick the DYMO. Then press Test print.</li>
          <li>
            Leave this window open. It&apos;s fine behind other windows. The scale and printer only work in Chrome or
            Edge on a computer.
          </li>
        </ol>
      </details>
    </Card>
  );
}
