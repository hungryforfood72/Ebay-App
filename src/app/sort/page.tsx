"use client";

import { ScanField } from "@/components/ScanField";
import { StationPicker, useChosenStation } from "@/components/StationPicker";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/Input";
import type { DudBoxDetail, DudBoxSummary } from "@/lib/warehouse/dudBoxTypes";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import {
  Ban,
  ChevronRight,
  CircleCheck,
  FileSpreadsheet,
  LoaderCircle,
  Minus,
  PackageOpen,
  PackageX,
  Plus,
  Printer,
  SearchX,
  ThumbsUp,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

// Sort station: one person goes through a load before it's listed and
// pulls the units that won't be listed, so listers only get good stock.
// Cristian: "take the thinking away from the sorter." Scan a UPC and the
// screen gives one big answer:
//   - DUD (the Analyzer already called it before the load was bought, or
//     eBay doesn't allow it): it goes in the load's dud box. One tap.
//   - otherwise: good, pass it to the lister. One tap.
// Damaged and expired are the second choice either way, logged with the
// manifest's damaged tally (note "damaged" / "expired" so both stay
// countable). "I have X of these" logs a stack in one go.
//
// Dud boxes (DudBox): each load's duds go in a box with its own printed
// label (DB0001), so nobody tracks by hand which load they came from.
// Someone processes the box later on /duds. This device remembers the
// box it's filling for each load.
//
// Several people can sort the same load at once: counts come from the
// server (/api/sort/check), fetched on every scan and after every log.

type ManifestSummary = {
  id: string;
  title: string;
  createdAt: string;
  _count: { lines: number; items: number };
};

// GET /api/sort/check
type CheckResult = {
  manifest: { id: string; title: string };
  evaluated: boolean;
  line: {
    upc: string;
    description: string;
    expected: number;
    received: number;
    damaged: number;
    dud: number;
    leftToSort: number;
  } | null;
  dud: boolean;
  dudReason: string | null;
};

type Scan = { code: string; loading: boolean; result: CheckResult | null; error: string | null };

type Kind = "good" | "dud" | "damaged" | "expired";

type LogEntry = { id: number; kind: Kind; quantity: number; description: string; failed?: boolean };

type ActiveBox = { code: string; units: number };

type Message = { tone: "success" | "warning" | "danger"; text: string };

const SORT_MANIFEST_KEY = "ebay-tool.sortManifestId";
// The dud box this device is filling, per load.
const dudBoxKey = (manifestId: string) => `ebay-tool.sortDudBox.${manifestId}`;

const KIND_TEXT: Record<Kind, string> = {
  good: "good, to the lister",
  dud: "into the dud box",
  damaged: "damaged",
  expired: "expired",
};

const KIND_SHORT: Record<Kind, string> = { good: "Good", dud: "Dud", damaged: "Damaged", expired: "Expired" };

// localStorage can throw (private window, storage blocked). Not remembering
// is fine: the page just asks again.
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Not remembered on this device; fine for this visit.
  }
}

// Short tone so the answer registers without looking at the screen. Same
// idea as the pick page: one high beep = good, falling two-tone = dud, two
// low = not on the manifest.
function beep(kind: "good" | "dud" | "missing") {
  try {
    const ctx = new AudioContext();
    const tones = kind === "good" ? [880] : kind === "dud" ? [660, 440] : [220, 220];
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
    navigator.vibrate?.(kind === "good" ? 80 : kind === "dud" ? 250 : [80, 60, 80]);
  } catch {
    // No audio (or no permission yet) is fine: the screen shows the answer.
  }
}

function focusScan() {
  requestAnimationFrame(() => document.getElementById("sort-upc")?.focus());
}

// The API's own message, plus the status so callers can tell "that box
// was closed" (409/404) from a dropped connection.
class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? fallback, res.status);
  return data as T;
}

function boxUnits(detail: DudBoxDetail): number {
  return detail.entries.reduce((sum, e) => sum + e.quantity, 0);
}

export default function SortPage() {
  const [manifestId, setManifestId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readStored(SORT_MANIFEST_KEY)
  );
  const [manifests, setManifests] = useState<ManifestSummary[] | null>(null);
  const [info, setInfo] = useState<{ title: string; evaluated: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const checkId = useRef(0);
  const [quantity, setQuantity] = useState("1");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // This device's sorting so far on this load. Good units are only counted
  // here (they're logged when a lister saves them); the rest are saved.
  const [tally, setTally] = useState<Record<Kind, number>>({ good: 0, dud: 0, damaged: 0, expired: 0 });
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);

  // Dud box this device is filling for the load. boxChecked = the
  // remembered one has been re-checked with the server.
  const [box, setBox] = useState<ActiveBox | null>(null);
  const [boxChecked, setBoxChecked] = useState(false);
  // Other open boxes for this load (another sorter's, or one this device
  // forgot), offered instead of starting yet another.
  const [openBoxes, setOpenBoxes] = useState<DudBoxSummary[]>([]);
  const [starting, setStarting] = useState(false);
  const [pickingStation, setPickingStation] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // A closed box of this load was scanned: offer to reopen it.
  const [reopenCode, setReopenCode] = useState<string | null>(null);
  // A dud tapped before any box was open: logged as soon as one starts.
  const [pendingDud, setPendingDud] = useState<{ upc: string; quantity: number; description: string } | null>(null);
  const [boxBusy, setBoxBusy] = useState(false);

  const stations = useChosenStation(true);

  // Starting a box (or picking a station for it) happens in the box card
  // below the scan answer; bring it on screen on the handheld.
  useEffect(() => {
    if (starting || pickingStation) {
      document.getElementById("dud-box-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [starting, pickingStation]);

  useEffect(() => {
    if (manifestId) return;
    fetch("/api/manifests")
      .then((r) => r.json())
      .then((list) => setManifests(Array.isArray(list) ? list : []))
      .catch(() => setManifests([]));
  }, [manifestId]);

  useEffect(() => {
    if (!manifestId) return;
    let cancelled = false;
    fetch(`/api/sort/check?manifestId=${encodeURIComponent(manifestId)}`)
      .then((r) => readJson<CheckResult>(r, "Couldn't load that load."))
      .then((d) => {
        if (cancelled) return;
        setInfo({ title: d.manifest.title, evaluated: d.evaluated });
        setLoadError(null);
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "Couldn't load that load."));
    return () => {
      cancelled = true;
    };
  }, [manifestId]);

  // Re-check the remembered dud box: someone may have closed it, or it may
  // be from an old visit. Also finds other open boxes for this load.
  useEffect(() => {
    if (!manifestId) return;
    let cancelled = false;
    (async () => {
      const stored = readStored(dudBoxKey(manifestId));
      let active: ActiveBox | null = null;
      if (stored) {
        try {
          const detail = await readJson<DudBoxDetail>(await fetch(`/api/dud-boxes/${encodeURIComponent(stored)}`), "");
          if (detail.box.manifestId === manifestId && detail.box.status === "open") {
            active = { code: detail.box.code, units: boxUnits(detail) };
          }
        } catch (e) {
          // No connection: keep using it, the next log re-checks it. Gone
          // (or refused): forget it below.
          if (!(e instanceof ApiError)) active = { code: stored, units: 0 };
        }
        if (!active) writeStored(dudBoxKey(manifestId), null);
      }
      let others: DudBoxSummary[] = [];
      try {
        const list = await readJson<{ boxes: DudBoxSummary[] }>(
          await fetch(`/api/dud-boxes?status=open&manifestId=${encodeURIComponent(manifestId)}`),
          ""
        );
        others = list.boxes.filter((b) => b.code !== active?.code);
      } catch {
        // Just no suggestions.
      }
      if (cancelled) return;
      setBox(active);
      setOpenBoxes(others);
      setBoxChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [manifestId]);

  function pickManifest(id: string | null) {
    writeStored(SORT_MANIFEST_KEY, id);
    setManifestId(id);
    setInfo(null);
    setLoadError(null);
    setScan(null);
    setMessage(null);
    setTally({ good: 0, dud: 0, damaged: 0, expired: 0 });
    setLog([]);
    setBox(null);
    setBoxChecked(false);
    setOpenBoxes([]);
    setStarting(false);
    setConfirmClose(false);
    setReopenCode(null);
    setPendingDud(null);
    if (!id) setManifests(null);
  }

  function rememberBox(next: ActiveBox | null) {
    if (manifestId) writeStored(dudBoxKey(manifestId), next?.code ?? null);
    setBox(next);
    if (next) setOpenBoxes((list) => list.filter((b) => b.code !== next.code));
  }

  // quiet = a refresh after logging: no beep, keep the quantity.
  async function runCheck(raw: string, quiet = false) {
    if (!manifestId) return;
    const id = ++checkId.current;
    if (!quiet) {
      setScan({ code: raw, loading: true, result: null, error: null });
      setQuantity("1");
    }
    try {
      const res = await fetch(
        `/api/sort/check?manifestId=${encodeURIComponent(manifestId)}&upc=${encodeURIComponent(raw)}`
      );
      const result = await readJson<CheckResult>(res, "Couldn't check that one. Scan it again.");
      if (id !== checkId.current) return;
      setScan({ code: raw, loading: false, result, error: null });
      if (!quiet) beep(!result.line ? "missing" : result.dud ? "dud" : "good");
    } catch (e) {
      if (id !== checkId.current) return;
      if (quiet) return; // keeps the last counts; the next scan tries again
      setScan({
        code: raw,
        loading: false,
        result: null,
        error: e instanceof Error ? e.message : "Couldn't check that one.",
      });
    }
  }

  function handleScan() {
    const raw = code.trim();
    setCode("");
    if (!raw) return;
    setMessage(null);
    setReopenCode(null);
    if (classifyScan(raw) === "dudbox") {
      void activateScannedBox(normalizeCode(raw));
    } else {
      void runCheck(raw);
    }
    focusScan();
  }

  // Scanned a dud box label: make it this device's box for the load, if
  // it belongs to this load and is still open.
  async function activateScannedBox(boxCode: string) {
    if (!manifestId) return;
    try {
      const detail = await readJson<DudBoxDetail>(
        await fetch(`/api/dud-boxes/${encodeURIComponent(boxCode)}`),
        "Couldn't read that dud box."
      );
      if (detail.box.manifestId !== manifestId) {
        beep("missing");
        setMessage({
          tone: "danger",
          text: `${detail.box.code} is for a different load (${detail.box.manifestTitle}). Use a dud box for this load.`,
        });
        return;
      }
      if (detail.box.status === "done") {
        beep("missing");
        setMessage({ tone: "danger", text: `${detail.box.code} was already processed. Start a new dud box.` });
        return;
      }
      if (detail.box.status === "closed") {
        beep("missing");
        setReopenCode(detail.box.code);
        return;
      }
      rememberBox({ code: detail.box.code, units: boxUnits(detail) });
      setStarting(false);
      beep("good");
      setMessage({ tone: "success", text: `Using dud box ${detail.box.code}. Scan the next item.` });
    } catch (e) {
      beep("missing");
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Couldn't read that dud box." });
    }
  }

  async function reopenBox(boxCode: string) {
    setBoxBusy(true);
    try {
      await readJson(
        await fetch(`/api/dud-boxes/${encodeURIComponent(boxCode)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "open" }),
        }),
        "Couldn't reopen that box."
      );
      setReopenCode(null);
      await activateScannedBox(boxCode);
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Couldn't reopen that box." });
    } finally {
      setBoxBusy(false);
      focusScan();
    }
  }

  function addToLog(entry: Omit<LogEntry, "id">) {
    const id = ++logId.current;
    setLog((prev) => [{ id, ...entry }, ...prev].slice(0, 12));
  }

  // Puts units in a dud box. Returns false if it didn't save.
  async function logDud(boxCode: string, upc: string, qty: number, description: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/dud-boxes/${encodeURIComponent(boxCode)}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestId, upc, quantity: qty }),
      });
      const data = await readJson<{ box: { code: string; units: number } }>(res, "Save failed.");
      rememberBox({ code: data.box.code, units: data.box.units });
      setTally((t) => ({ ...t, dud: t.dud + qty }));
      addToLog({ kind: "dud", quantity: qty, description });
      setMessage({ tone: "success", text: `Put ${qty} in dud box ${data.box.code}. Scan the next one.` });
      return true;
    } catch (e) {
      const text = e instanceof Error ? e.message : "Something went wrong. Try again.";
      addToLog({ kind: "dud", quantity: qty, description, failed: true });
      // The box was closed (or processed) from another device: stop using
      // it and offer a new one, keeping this dud to log into it.
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        rememberBox(null);
        setPendingDud({ upc, quantity: qty, description });
        setStarting(true);
      }
      setMessage({ tone: "danger", text });
      return false;
    }
  }

  async function record(kind: Kind) {
    if (!scan || !manifestId || saving) return;
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      setMessage({ tone: "warning", text: "Enter how many, at least 1." });
      return;
    }
    const line = scan.result?.line ?? null;
    // The manifest's own UPC when it matched, so the count lands on that
    // line even if the scan reads the barcode a little differently.
    const upc = line?.upc ?? scan.code;
    const description = line?.description ?? `UPC ${scan.code}`;
    setMessage(null);

    if (kind === "good") {
      setTally((t) => ({ ...t, good: t.good + qty }));
      addToLog({ kind, quantity: qty, description });
      setQuantity("1");
      setMessage({ tone: "success", text: `Logged ${qty} ${KIND_TEXT.good}. Scan the next one.` });
      focusScan();
      return;
    }

    if (kind === "dud" && !box) {
      // No box yet: the same tap starts one (label at this handheld's
      // station) and puts the dud in it. Without a station, it asks for
      // one first and the dud waits.
      const pending = { upc, quantity: qty, description };
      if (stations.station) {
        void startBox(true, pending);
      } else {
        setPendingDud(pending);
        setStarting(true);
        setMessage({ tone: "warning", text: "Start a dud box first. This one goes in as soon as it's started." });
      }
      return;
    }

    setSaving(true);
    let ok = true;
    if (kind === "dud") {
      ok = await logDud(box!.code, upc, qty, description);
    } else {
      try {
        // Damaged and expired share the manifest's damaged tally; the note
        // keeps them apart for the numbers.
        const res = await fetch(`/api/manifests/${manifestId}/damaged`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ upc, quantity: qty, note: kind }),
        });
        await readJson(res, "Save failed.");
        setTally((t) => ({ ...t, [kind]: t[kind] + qty }));
        addToLog({ kind, quantity: qty, description });
        setMessage({ tone: "success", text: `Logged ${qty} ${KIND_TEXT[kind]}. Scan the next one.` });
      } catch (e) {
        ok = false;
        addToLog({ kind, quantity: qty, description, failed: true });
        setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Something went wrong. Try again." });
      }
    }
    setSaving(false);
    if (ok) {
      setQuantity("1");
      void runCheck(scan.code, true);
    }
    focusScan();
  }

  async function startBox(print: boolean, pending = pendingDud) {
    if (!manifestId || boxBusy) return;
    setBoxBusy(true);
    try {
      const res = await fetch("/api/dud-boxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestId, stationId: print ? stations.station?.id : null }),
      });
      const data = await readJson<{ box: { code: string }; printed: boolean; printError: string | null }>(
        res,
        "Couldn't start a dud box."
      );
      rememberBox({ code: data.box.code, units: 0 });
      setStarting(false);
      setPickingStation(false);
      const where = data.printed
        ? `Its label is printing at ${stations.station?.name ?? "the station"}. Stick it on the box.`
        : data.printError
          ? `The label didn't print: ${data.printError}`
          : "No label printed. Reprint it when you're at a station.";
      setMessage({ tone: data.printError ? "warning" : "success", text: `Dud box ${data.box.code} started. ${where}` });
      if (pending) {
        const p = pending;
        setPendingDud(null);
        setSaving(true);
        const ok = await logDud(data.box.code, p.upc, p.quantity, p.description);
        setSaving(false);
        if (ok) {
          setQuantity("1");
          if (scan) void runCheck(scan.code, true);
        }
      }
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Couldn't start a dud box." });
    } finally {
      setBoxBusy(false);
      focusScan();
    }
  }

  async function closeBox() {
    if (!box || boxBusy) return;
    setBoxBusy(true);
    try {
      await readJson(
        await fetch(`/api/dud-boxes/${encodeURIComponent(box.code)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "closed" }),
        }),
        "Couldn't close the box."
      );
      setMessage({ tone: "success", text: `${box.code} closed. Set it aside for processing and start the next box.` });
      rememberBox(null);
      setConfirmClose(false);
      setStarting(true);
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Couldn't close the box." });
    } finally {
      setBoxBusy(false);
      focusScan();
    }
  }

  async function reprint() {
    if (!box || boxBusy) return;
    if (!stations.station) {
      setPickingStation(true);
      return;
    }
    setBoxBusy(true);
    try {
      await readJson(
        await fetch(`/api/dud-boxes/${encodeURIComponent(box.code)}/print`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stationId: stations.station.id }),
        }),
        "Couldn't print the label."
      );
      setMessage({ tone: "success", text: `Label for ${box.code} is printing at ${stations.station.name}.` });
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Couldn't print the label." });
    } finally {
      setBoxBusy(false);
      focusScan();
    }
  }

  if (!manifestId) {
    return (
      <AppShell
        width="narrow"
        title="Sort"
        subtitle="Pull duds, damaged and expired units before listing. Pick the load."
      >
        {manifests === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {manifests && manifests.length === 0 && (
          <Card>
            <p className="text-sm text-muted-foreground">No manifests yet.</p>
          </Card>
        )}
        {manifests && manifests.length > 0 && (
          <ul className="flex flex-col gap-2">
            {manifests.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => pickManifest(m.id)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left shadow-sm transition-colors hover:bg-muted active:bg-muted"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-blue-50 text-primary">
                    <FileSpreadsheet className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{m.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {m._count.lines} lines · {new Date(m.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </AppShell>
    );
  }

  const result = scan?.result ?? null;
  const line = result?.line ?? null;
  const isDud = Boolean(line && result?.dud);
  const showActions = Boolean(scan && !scan.loading && result);
  const stationList = stations.stations;
  // Unknown while loading counts as "has stations" so the no-label button
  // doesn't flash; a failed load counts as none so a box can still start.
  const hasStations = stations.error ? false : stationList == null || stationList.length > 0;

  return (
    <AppShell
      focused
      width="narrow"
      title="Sort"
      subtitle={info ? info.title : loadError ? undefined : "Loading…"}
      actions={
        <Button variant="outline" size="sm" onClick={() => pickManifest(null)}>
          Change load
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {loadError && (
          <Alert
            tone="danger"
            action={
              <Button variant="outline" size="sm" onClick={() => pickManifest(null)}>
                Pick another load
              </Button>
            }
          >
            {loadError}
          </Alert>
        )}

        <div className="grid grid-cols-4 gap-2 text-center">
          <TallyTile label="Good" value={tally.good} tone="success" />
          <TallyTile label="Dud" value={tally.dud} tone="warning" />
          <TallyTile label="Damaged" value={tally.damaged} tone="danger" />
          <TallyTile label="Expired" value={tally.expired} tone="danger" />
        </div>

        {info && !info.evaluated && (
          <p className="text-sm text-muted-foreground">
            This load never went through the Analyzer, so nothing is called a dud for you. Use the dud box for anything
            that clearly won&apos;t sell.
          </p>
        )}

        <Card>
          <ScanField
            id="sort-upc"
            label="UPC"
            prompt="Scan the item's UPC"
            numeric
            autoFocus
            value={code}
            onChange={setCode}
            onScan={handleScan}
            hint="Scan a dud box label to fill that box instead."
          />
        </Card>

        {scan?.loading && (
          <Card>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Checking {scan.code}…
            </p>
          </Card>
        )}

        {scan?.error && <Alert tone="danger">{scan.error}</Alert>}

        {scan && result && !line && (
          <div role="alert" className="rounded-xl border-2 border-red-300 bg-red-50 p-4 text-red-950">
            <div className="flex gap-2">
              <SearchX className="mt-0.5 size-6 shrink-0 text-red-600" aria-hidden />
              <div className="min-w-0">
                <p className="text-lg font-semibold">Not on this manifest</p>
                <p className="mt-0.5 break-all text-sm tabular-nums text-red-900/80">Scanned: {scan.code}</p>
                <p className="mt-1 text-sm">Check the barcode, or set it aside. You can still log it below.</p>
              </div>
            </div>
          </div>
        )}

        {line && isDud && (
          <div role="alert" className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950">
            <div className="flex gap-3">
              <Ban className="mt-1 size-8 shrink-0 text-amber-600" aria-hidden />
              <div className="min-w-0">
                <p className="text-2xl font-bold leading-tight">DUD: put it in the dud box</p>
                {result?.dudReason && <p className="mt-1 text-sm font-medium">{result.dudReason}</p>}
                <p className="mt-2 text-sm">
                  {box ? (
                    <>
                      Dud box <span className="font-mono font-bold">{box.code}</span>
                    </>
                  ) : (
                    "No dud box yet. Tapping below starts one."
                  )}
                </p>
              </div>
            </div>
          </div>
        )}

        {line && (
          <Card>
            <p className="font-semibold leading-snug text-foreground">{line.description}</p>
            <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">UPC {line.upc}</p>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center">
              <Count label="Expected" value={line.expected} />
              <Count label="Listed" value={line.received} />
              <Count label="Damaged" value={line.damaged} />
              <Count label="Dud" value={line.dud} />
            </div>
            <p className={cn("mt-2 text-sm font-medium", line.leftToSort > 0 ? "text-foreground" : "text-warning")}>
              {line.leftToSort > 0
                ? `${line.leftToSort} still to sort or list`
                : line.leftToSort === 0
                  ? "All accounted for already. This one may be extra."
                  : `${-line.leftToSort} more than the manifest listed.`}
            </p>
            {!isDud && result?.dudReason && <p className="mt-1 text-xs text-muted-foreground">{result.dudReason}</p>}
          </Card>
        )}

        {showActions && scan && result && (
          <>
            <div>
              <p className="mb-1.5 text-sm font-medium text-foreground">I have this many</p>
              <div className="grid grid-cols-[3.5rem_1fr_3.5rem] gap-2">
                <Button
                  variant="outline"
                  size="icon-xl"
                  aria-label="One less"
                  onClick={() => setQuantity((q) => String(Math.max(1, (Number(q) || 1) - 1)))}
                >
                  <Minus className="size-5" aria-hidden />
                </Button>
                <Input
                  size="lg"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  className="text-center"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                />
                <Button
                  variant="outline"
                  size="icon-xl"
                  aria-label="One more"
                  onClick={() => setQuantity((q) => String((Number(q) || 0) + 1))}
                >
                  <Plus className="size-5" aria-hidden />
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              {isDud ? (
                <Button variant="warning" size="xl" block onClick={() => record("dud")} disabled={saving || boxBusy}>
                  <PackageX className="size-5" aria-hidden />
                  {box ? `Put in dud box ${box.code}` : "Start a dud box"}
                </Button>
              ) : (
                <Button variant="success" size="xl" block onClick={() => record("good")} disabled={saving}>
                  <ThumbsUp className="size-5" aria-hidden />
                  Good, pass to lister
                </Button>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="danger-ghost"
                  size="lg"
                  className="border border-red-200"
                  onClick={() => record("damaged")}
                  disabled={saving}
                >
                  {isDud ? "It's damaged" : "Damaged"}
                </Button>
                <Button
                  variant="danger-ghost"
                  size="lg"
                  className="border border-red-200"
                  onClick={() => record("expired")}
                  disabled={saving}
                >
                  {isDud ? "It's expired" : "Expired"}
                </Button>
              </div>
              {!isDud && (
                <Button variant="ghost" size="md" onClick={() => record("dud")} disabled={saving || boxBusy}>
                  Put in the dud box instead
                </Button>
              )}
            </div>
          </>
        )}

        {message && (
          <div
            role="status"
            className={cn(
              "flex items-start gap-2 rounded-xl border px-4 py-3 text-sm font-medium",
              message.tone === "success"
                ? "border-green-200 bg-green-50 text-green-900"
                : message.tone === "danger"
                  ? "border-red-200 bg-red-50 text-red-900"
                  : "border-amber-200 bg-amber-50 text-amber-950"
            )}
          >
            {message.tone === "success" ? (
              <CircleCheck className="mt-0.5 size-5 shrink-0 text-green-600" aria-hidden />
            ) : (
              <TriangleAlert
                className={cn("mt-0.5 size-5 shrink-0", message.tone === "danger" ? "text-red-600" : "text-amber-600")}
                aria-hidden
              />
            )}
            {message.text}
          </div>
        )}

        {reopenCode && (
          <Alert
            tone="warning"
            title={`${reopenCode} is closed`}
            action={
              <div className="flex flex-wrap gap-2">
                <Button variant="warning" size="sm" onClick={() => reopenBox(reopenCode)} disabled={boxBusy}>
                  Reopen it and fill it
                </Button>
                <Button variant="outline" size="sm" onClick={() => setReopenCode(null)}>
                  Never mind
                </Button>
              </div>
            }
          >
            Someone marked it full. Reopen it only if there&apos;s room in it.
          </Alert>
        )}

        <div id="dud-box-card">
          <DudBoxCard
            box={box}
            checked={boxChecked}
            openBoxes={openBoxes}
            starting={starting}
            busy={boxBusy}
            confirmClose={confirmClose}
            stationName={stations.station?.name ?? null}
            hasStations={hasStations}
            pickingStation={pickingStation || (starting && stations.needsStation && hasStations)}
            stationPicker={
              <StationPicker
                stations={stations.stations}
                selectedId={stations.station?.id ?? null}
                error={stations.error}
                onPick={(s) => {
                  stations.choose(s.id);
                  setPickingStation(false);
                }}
                onCancel={stations.station ? () => setPickingStation(false) : undefined}
                onReload={stations.reload}
              />
            }
            onStart={() => setStarting(true)}
            onCancelStart={() => {
              setStarting(false);
              setPendingDud(null);
            }}
            onConfirmStart={(print) => startBox(print)}
            onUse={(c) => activateScannedBox(c)}
            onChangeStation={() => setPickingStation(true)}
            onAskClose={() => setConfirmClose(true)}
            onCancelClose={() => setConfirmClose(false)}
            onClose={closeBox}
            onReprint={reprint}
            pendingDud={pendingDud != null}
          />
        </div>

        {log.length > 0 && (
          <section>
            <SectionHeader title="Just now" action={<Badge>{log.length}</Badge>} />
            <ul className="divide-y divide-border rounded-xl border border-border bg-surface text-sm">
              {log.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                  <span
                    className={cn(
                      "w-20 shrink-0 text-xs font-semibold",
                      e.failed
                        ? "text-muted-foreground line-through"
                        : e.kind === "good"
                          ? "text-success"
                          : e.kind === "dud"
                            ? "text-warning"
                            : "text-danger"
                    )}
                  >
                    {KIND_SHORT[e.kind]} ×{e.quantity}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{e.description}</span>
                  {e.failed && <span className="shrink-0 text-xs text-danger">Not saved</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </AppShell>
  );
}

// The load's dud box on this device: which one is being filled, starting a
// new one (label prints at this handheld's station), closing a full one.
function DudBoxCard(props: {
  box: ActiveBox | null;
  checked: boolean;
  openBoxes: DudBoxSummary[];
  starting: boolean;
  busy: boolean;
  confirmClose: boolean;
  stationName: string | null;
  hasStations: boolean;
  pickingStation: boolean;
  stationPicker: ReactNode;
  pendingDud: boolean;
  onStart: () => void;
  onCancelStart: () => void;
  onConfirmStart: (print: boolean) => void;
  onUse: (code: string) => void;
  onChangeStation: () => void;
  onAskClose: () => void;
  onCancelClose: () => void;
  onClose: () => void;
  onReprint: () => void;
}) {
  const { box } = props;

  if (box && props.pickingStation) return <>{props.stationPicker}</>;

  if (box) {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700">
            <PackageOpen className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">Dud box</p>
            <p className="font-mono text-xl font-bold leading-tight text-foreground">{box.code}</p>
          </div>
          <p className="shrink-0 text-sm tabular-nums text-muted-foreground">
            {box.units} {box.units === 1 ? "unit" : "units"}
          </p>
        </div>
        {props.confirmClose ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-950">Close {box.code}? You&apos;ll start a new box next.</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button variant="warning" onClick={props.onClose} disabled={props.busy}>
                Yes, it&apos;s full
              </Button>
              <Button variant="outline" onClick={props.onCancelClose} disabled={props.busy}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={props.onAskClose} disabled={props.busy}>
              Box is full, close it
            </Button>
            <Button variant="outline" onClick={props.onReprint} disabled={props.busy}>
              <Printer className="size-4" aria-hidden />
              Reprint label
            </Button>
          </div>
        )}
      </Card>
    );
  }

  if (!props.checked) {
    return (
      <Card>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Checking this load&apos;s dud box…
        </p>
      </Card>
    );
  }

  if (!props.starting) {
    return (
      <Card>
        <SectionHeader
          title="No dud box open"
          description="Duds from this load go in a labeled box. Start one, or scan a box's label."
        />
        <OpenBoxList boxes={props.openBoxes} onUse={props.onUse} busy={props.busy} />
        <Button variant="outline" block onClick={props.onStart}>
          <PackageOpen className="size-4" aria-hidden />
          Start a dud box
        </Button>
      </Card>
    );
  }

  if (props.pickingStation) return <>{props.stationPicker}</>;

  return (
    <Card className="border-amber-300">
      <SectionHeader
        title="Start a dud box"
        description={
          props.pendingDud
            ? "The dud you just scanned goes in it right away."
            : "Grab an empty box. Its label prints now."
        }
      />
      <OpenBoxList boxes={props.openBoxes} onUse={props.onUse} busy={props.busy} />
      {props.stationName && (
        <p className="mb-3 text-sm text-muted-foreground">
          Label prints at <span className="font-medium text-foreground">{props.stationName}</span>.{" "}
          <button type="button" className="font-medium text-primary hover:underline" onClick={props.onChangeStation}>
            Change
          </button>
        </p>
      )}
      <div className="flex flex-col gap-2">
        {props.stationName && (
          <Button variant="warning" size="xl" block onClick={() => props.onConfirmStart(true)} disabled={props.busy}>
            <Printer className="size-5" aria-hidden />
            Start box and print label
          </Button>
        )}
        {!props.hasStations && (
          <Button variant="warning" size="xl" block onClick={() => props.onConfirmStart(false)} disabled={props.busy}>
            Start box without a label
          </Button>
        )}
        <Button variant="ghost" onClick={props.onCancelStart} disabled={props.busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function OpenBoxList({ boxes, onUse, busy }: { boxes: DudBoxSummary[]; onUse: (code: string) => void; busy: boolean }) {
  if (boxes.length === 0) return null;
  return (
    <div className="mb-3">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Already open for this load</p>
      <ul className="flex flex-col gap-2">
        {boxes.map((b) => (
          <li key={b.code}>
            <Button variant="outline" block onClick={() => onUse(b.code)} disabled={busy} className="justify-between">
              <span className="font-mono font-bold">{b.code}</span>
              <span className="text-sm text-muted-foreground">
                {b.units} {b.units === 1 ? "unit" : "units"} · Use it
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TALLY_TONES = {
  success: "border-green-200 bg-green-50 text-green-800",
  danger: "border-red-200 bg-red-50 text-red-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
} as const;

function TallyTile({ label, value, tone }: { label: string; value: number; tone: keyof typeof TALLY_TONES }) {
  return (
    <div className={cn("rounded-lg border px-1 py-2", TALLY_TONES[tone])}>
      <p className="text-xs font-medium">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-background px-1 py-2">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  );
}
