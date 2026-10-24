"use client";

import { ScanField } from "@/components/ScanField";
import { StationPicker, useChosenStation } from "@/components/StationPicker";
import { useCurrentUser } from "@/components/UserNav";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/Input";
import type { DudBoxDetail, DudBoxSummary } from "@/lib/warehouse/dudBoxTypes";
import { keyLabel } from "@/lib/upcMatch";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import {
  Ban,
  Boxes,
  ChevronRight,
  CircleCheck,
  FileSpreadsheet,
  LoaderCircle,
  Minus,
  PackageCheck,
  PackageOpen,
  PackageX,
  Plus,
  Printer,
  SearchX,
  ThumbsUp,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

// Sort station. Cristian (2026-10-18): sort the WHOLE load before listing,
// so the lister never waits on a unit buried at the bottom of the pallet
// and the real counts (short, over, extras) are known up front. And "take
// the thinking away from the sorter": scan a UPC and the screen gives one
// big answer.
//   - DUD (the Analyzer already called it before the load was bought, or
//     eBay doesn't allow it): it goes in the dud box. One tap.
//   - otherwise: good, into the sort box. One tap.
// Damaged and expired are the second choice either way, logged with the
// manifest's damaged tally (note "damaged" / "expired" so both stay
// countable). "I have this many" logs a stack in one go. Not on the
// manifest: "Box it as extra" (good, counted separately).
//
// The handheld holds TWO active boxes at once, so the sorter never switches:
//   - a sort box (SB0001, reusable, printed ahead of time): every good unit
//     goes in it; the List page later says which boxes hold a product.
//     Scanning an SB label makes it the good box.
//   - a dud box (DB0001, one load's duds, label printed when started):
//     scanning a DB label makes it the dud box, or start a new one here.
// Each has its own "full" button that only clears that one. Both are
// remembered per load on this device and re-checked when the page loads.
//
// Several people can sort the same load at once, each with their own boxes:
// counts come from the server (/api/sort/check), fetched on every scan and
// after every log.
//
// Consignment loads (Cristian, 2026-10-21) count what the supplier really
// delivered. No dud box (it's all still the supplier's): the answer is the
// pick list's take or leave instead. TAKE = good, into the sort box. LEAVE,
// or not on the manifest = "Set aside for the supplier", logged so the
// manifest page lists what goes back. The owner can still keep one anyway.

type ManifestSummary = {
  id: string;
  title: string;
  createdAt: string;
  _count: { lines: number; items: number };
};

// GET /api/sort/check
type CheckResult = {
  manifest: { id: string; title: string; sortedAt: string | null; sortedBy: string | null };
  evaluated: boolean;
  consignment: boolean;
  // Sorted without sort boxes (Manifest.sortWithoutBoxes): Good just
  // counts units in.
  sortWithoutBoxes: boolean;
  // Products on the load with no UPC but an Item # (typed in instead).
  itemNumberLines: number;
  // Consignment loads only: what the pick list said for this product.
  consignmentCall: { decision: "take" | "leave"; reason: string | null } | null;
  line: {
    upc: string;
    description: string;
    expected: number;
    sorted: number;
    damaged: number;
    dudLogged: number;
    // Consignment: set aside for the supplier.
    returned: number;
    leftToSort: number;
    over: number;
  } | null;
  extraSorted: number;
  dud: boolean;
  dudReason: string | null;
};

type Scan = { code: string; loading: boolean; result: CheckResult | null; error: string | null };

type Kind = "good" | "extra" | "dud" | "damaged" | "expired" | "return";

// What /api/sort/undo needs to take a log back.
type LogRef = { kind: "good" | "dud" | "damaged" | "return"; id: string; boxCode: string | null };

type LogEntry = {
  id: number;
  kind: Kind;
  quantity: number;
  description: string;
  failed?: boolean;
  ref?: LogRef;
  undone?: boolean;
};

type SortBoxState = { code: string; unitsLeft: number };
type DudBoxState = { code: string; units: number };

// GET /api/sort-boxes/{code}
type SortBoxSummary = { code: string; manifestId: string | null; unitsLeft: number };

// A tap made before the matching box was active; logged as soon as it is.
type Pending = { code: string; upc: string; quantity: number; description: string; extra: boolean };

type Message = { tone: "success" | "warning" | "danger"; text: string };

const SORT_MANIFEST_KEY = "ebay-tool.sortManifestId";
// The boxes this device is filling, per load.
const dudBoxKey = (manifestId: string) => `ebay-tool.sortDudBox.${manifestId}`;
const goodBoxKey = (manifestId: string) => `ebay-tool.sortGoodBox.${manifestId}`;

const KIND_SHORT: Record<Kind, string> = {
  good: "Good",
  extra: "Extra",
  dud: "Dud",
  damaged: "Damaged",
  expired: "Expired",
  return: "To supplier",
};

const EMPTY_TALLY: Record<Kind, number> = { good: 0, extra: 0, dud: 0, damaged: 0, expired: 0, return: 0 };

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
// low = not on the manifest (or refused).
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
// can't take it" (409/404) from a dropped connection.
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

function postJson(url: string, body: unknown, method = "POST") {
  return fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function boxUnits(detail: DudBoxDetail): number {
  return detail.entries.reduce((sum, e) => sum + e.quantity, 0);
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

export default function SortPage() {
  const user = useCurrentUser();
  const isOwner = user?.role === "owner";
  const [manifestId, setManifestId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readStored(SORT_MANIFEST_KEY)
  );
  const [manifests, setManifests] = useState<ManifestSummary[] | null>(null);
  const [info, setInfo] = useState<{
    title: string;
    evaluated: boolean;
    consignment: boolean;
    sortWithoutBoxes: boolean;
    itemNumberLines: number;
    sortedAt: string | null;
    sortedBy: string | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const checkId = useRef(0);
  const [quantity, setQuantity] = useState("1");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // This device's sorting so far on this load (the server has the real
  // totals; this is "what I did").
  const [tally, setTally] = useState<Record<Kind, number>>(EMPTY_TALLY);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);

  // The good (sort) box and dud box this device is filling. *Checked = the
  // remembered one has been re-checked with the server.
  const [goodBox, setGoodBox] = useState<SortBoxState | null>(null);
  const [goodChecked, setGoodChecked] = useState(false);
  const [pendingGood, setPendingGood] = useState<Pending | null>(null);
  const [dudBox, setDudBox] = useState<DudBoxState | null>(null);
  const [dudChecked, setDudChecked] = useState(false);
  const [pendingDud, setPendingDud] = useState<Pending | null>(null);
  // Other open dud boxes for this load (another sorter's, or one this
  // device forgot), offered instead of starting yet another.
  const [openDudBoxes, setOpenDudBoxes] = useState<DudBoxSummary[]>([]);
  const [starting, setStarting] = useState(false);
  const [pickingStation, setPickingStation] = useState(false);
  // What a station pick is for: starting a dud box, or reprinting a label.
  const [stationFor, setStationFor] = useState<"start" | "reprint-good" | "reprint-dud">("start");
  const [confirmCloseDud, setConfirmCloseDud] = useState(false);
  // A closed dud box of this load was scanned: offer to reopen it.
  const [reopenCode, setReopenCode] = useState<string | null>(null);
  const [boxBusy, setBoxBusy] = useState(false);
  const [confirmDone, setConfirmDone] = useState(false);
  // Who else logged on this load lately, for the "Is everyone done?"
  // popup (null = still checking).
  const [otherSorters, setOtherSorters] = useState<OtherSorter[] | null>(null);

  const stations = useChosenStation(true);

  // Starting a dud box (or picking a station) happens in a card below the
  // scan answer; bring it on screen on the handheld.
  useEffect(() => {
    if (starting || pickingStation) {
      document.getElementById("sort-box-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
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
        setInfo({
          title: d.manifest.title,
          evaluated: d.evaluated,
          consignment: d.consignment,
          sortWithoutBoxes: d.sortWithoutBoxes,
          itemNumberLines: d.itemNumberLines,
          sortedAt: d.manifest.sortedAt,
          sortedBy: d.manifest.sortedBy,
        });
        setLoadError(null);
      })
      .catch((e) => !cancelled && setLoadError(errorText(e, "Couldn't load that load.")));
    return () => {
      cancelled = true;
    };
  }, [manifestId]);

  // Re-check the remembered boxes: a sort box may have been emptied and
  // taken by another load, a dud box closed from another device.
  useEffect(() => {
    if (!manifestId) return;
    let cancelled = false;
    (async () => {
      const storedGood = readStored(goodBoxKey(manifestId));
      let good: SortBoxState | null = null;
      if (storedGood) {
        try {
          const b = await readJson<SortBoxSummary>(
            await fetch(`/api/sort-boxes/${encodeURIComponent(storedGood)}`),
            ""
          );
          if (b.manifestId === manifestId) good = { code: b.code, unitsLeft: b.unitsLeft };
        } catch (e) {
          // No connection: keep using it, the next log re-checks it.
          if (!(e instanceof ApiError)) good = { code: storedGood, unitsLeft: 0 };
        }
        if (!good) writeStored(goodBoxKey(manifestId), null);
      }

      const storedDud = readStored(dudBoxKey(manifestId));
      let dud: DudBoxState | null = null;
      if (storedDud) {
        try {
          const detail = await readJson<DudBoxDetail>(
            await fetch(`/api/dud-boxes/${encodeURIComponent(storedDud)}`),
            ""
          );
          if (detail.box.manifestId === manifestId && detail.box.status === "open") {
            dud = { code: detail.box.code, units: boxUnits(detail) };
          }
        } catch (e) {
          if (!(e instanceof ApiError)) dud = { code: storedDud, units: 0 };
        }
        if (!dud) writeStored(dudBoxKey(manifestId), null);
      }
      let others: DudBoxSummary[] = [];
      try {
        const list = await readJson<{ boxes: DudBoxSummary[] }>(
          await fetch(`/api/dud-boxes?status=open&manifestId=${encodeURIComponent(manifestId)}`),
          ""
        );
        others = list.boxes.filter((b) => b.code !== dud?.code);
      } catch {
        // Just no suggestions.
      }
      if (cancelled) return;
      setGoodBox(good);
      setGoodChecked(true);
      setDudBox(dud);
      setOpenDudBoxes(others);
      setDudChecked(true);
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
    setTally(EMPTY_TALLY);
    setLog([]);
    setGoodBox(null);
    setGoodChecked(false);
    setPendingGood(null);
    setDudBox(null);
    setDudChecked(false);
    setPendingDud(null);
    setOpenDudBoxes([]);
    setStarting(false);
    setConfirmCloseDud(false);
    setReopenCode(null);
    setConfirmDone(false);
    if (!id) setManifests(null);
  }

  function rememberGood(next: SortBoxState | null) {
    if (manifestId) writeStored(goodBoxKey(manifestId), next?.code ?? null);
    setGoodBox(next);
  }

  function rememberDud(next: DudBoxState | null) {
    if (manifestId) writeStored(dudBoxKey(manifestId), next?.code ?? null);
    setDudBox(next);
    if (next) setOpenDudBoxes((list) => list.filter((b) => b.code !== next.code));
  }

  // quiet = a refresh after logging: no beep, keep the quantity.
  async function runCheck(raw: string, quiet = false): Promise<CheckResult | null> {
    if (!manifestId) return null;
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
      if (id !== checkId.current) return null;
      setScan({ code: raw, loading: false, result, error: null });
      if (!quiet) {
        beep(!result.line ? "missing" : result.dud || result.consignmentCall?.decision === "leave" ? "dud" : "good");
      }
      return result;
    } catch (e) {
      if (id !== checkId.current) return null;
      if (quiet) return null; // keeps the last counts; the next scan tries again
      setScan({ code: raw, loading: false, result: null, error: errorText(e, "Couldn't check that one.") });
      return null;
    }
  }

  // After a save: refresh the counts, and if they went over when this save
  // alone couldn't have (another sorter logged the same product at the
  // same moment, so both saw "1 left"), say so.
  async function refreshAfterSave(quantity: number) {
    if (!scan) return;
    const before = scan.result?.line ?? null;
    const after = (await runCheck(scan.code, true))?.line ?? null;
    if (!before || !after || before.over > 0 || before.leftToSort < quantity || after.over === 0) return;
    setMessage({
      tone: "warning",
      text: `Saved. Heads up: someone else sorted this at the same time, so it's ${after.over} over the manifest now.`,
    });
  }

  // Other sorters work the same load, so keep the product on screen
  // current: re-check it quietly every 5 seconds while it's showing.
  const liveCode = scan && !scan.loading && scan.result?.line ? scan.code : null;
  const pollCheck = useEffectEvent((code: string) => {
    if (document.visibilityState === "visible") void runCheck(code, true);
  });
  useEffect(() => {
    if (!liveCode || saving) return;
    const id = setInterval(() => pollCheck(liveCode), 5000);
    return () => clearInterval(id);
  }, [liveCode, saving]);

  function handleScan() {
    const raw = code.trim();
    setCode("");
    if (!raw) return;
    setMessage(null);
    setReopenCode(null);
    const kind = classifyScan(raw);
    if (kind === "sortbox" && info?.sortWithoutBoxes) {
      setMessage({ tone: "warning", text: "This load doesn't use sort boxes. Just scan the items." });
    } else if (kind === "sortbox") void activateGoodBox(normalizeCode(raw));
    else if (kind === "dudbox") void activateDudBox(normalizeCode(raw));
    else void runCheck(raw);
    focusScan();
  }

  function addToLog(entry: Omit<LogEntry, "id">) {
    const id = ++logId.current;
    setLog((prev) => [{ id, ...entry }, ...prev].slice(0, 12));
  }

  // ---- Good (sort) box -------------------------------------------------

  // Scanned a sort box label: make it this device's good box for the load.
  // An empty box is tied to this load; one still holding another load's
  // units is refused (the server says which load).
  async function activateGoodBox(boxCode: string) {
    if (!manifestId) return;
    try {
      const data = await readJson<{ box: SortBoxSummary }>(
        await postJson("/api/sort/activate", { boxCode, manifestId }),
        "Couldn't use that sort box."
      );
      rememberGood({ code: data.box.code, unitsLeft: data.box.unitsLeft });
      beep("good");
      if (pendingGood) {
        const p = pendingGood;
        setPendingGood(null);
        await saveGood(data.box.code, p);
      } else {
        setMessage({ tone: "success", text: `Good box is ${data.box.code} now. Scan the next item.` });
      }
    } catch (e) {
      beep("missing");
      setMessage({ tone: "danger", text: errorText(e, "Couldn't use that sort box.") });
    }
  }

  // Puts good units (or an extra) in the sort box, or just counts them in
  // on a load sorted without boxes (boxCode null). Returns false if it
  // didn't save.
  async function saveGood(boxCode: string | null, p: Pending): Promise<boolean> {
    setSaving(true);
    try {
      const data = await readJson<{ entry: { id: string }; box: SortBoxSummary | null }>(
        await postJson("/api/sort/log", { boxCode, manifestId, code: p.code, quantity: p.quantity, extra: p.extra }),
        "Save failed."
      );
      if (data.box) rememberGood({ code: data.box.code, unitsLeft: data.box.unitsLeft });
      const kind: Kind = p.extra ? "extra" : "good";
      setTally((t) => ({ ...t, [kind]: t[kind] + p.quantity }));
      addToLog({
        kind,
        quantity: p.quantity,
        description: p.description,
        ref: { kind: "good", id: data.entry.id, boxCode: data.box?.code ?? null },
      });
      setMessage({
        tone: "success",
        text: data.box ? `Put ${p.quantity} in ${data.box.code}. Scan the next one.` : `Counted ${p.quantity} in. Scan the next one.`,
      });
      setQuantity("1");
      void refreshAfterSave(p.quantity);
      return true;
    } catch (e) {
      addToLog({ kind: p.extra ? "extra" : "good", quantity: p.quantity, description: p.description, failed: true });
      // The box got tied to another load (emptied and reused elsewhere):
      // stop using it and keep these for the next box scanned.
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        rememberGood(null);
        setPendingGood(p);
        setMessage({ tone: "danger", text: `${e.message} Scan a sort box for this load; these go in it.` });
      } else {
        setMessage({ tone: "danger", text: errorText(e, "Something went wrong. Try again.") });
      }
      return false;
    } finally {
      setSaving(false);
      focusScan();
    }
  }

  function goodBoxFull() {
    if (!goodBox) return;
    setMessage({ tone: "success", text: `${goodBox.code} is full. Scan the next empty sort box.` });
    rememberGood(null);
    focusScan();
  }

  // ---- Dud box ---------------------------------------------------------

  // Scanned a dud box label: make it this device's dud box for the load, if
  // it belongs to this load and is still open.
  async function activateDudBox(boxCode: string) {
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
      rememberDud({ code: detail.box.code, units: boxUnits(detail) });
      setStarting(false);
      beep("good");
      if (pendingDud) {
        const p = pendingDud;
        setPendingDud(null);
        await saveDud(detail.box.code, p);
      } else {
        setMessage({ tone: "success", text: `Dud box is ${detail.box.code} now. Scan the next item.` });
      }
    } catch (e) {
      beep("missing");
      setMessage({ tone: "danger", text: errorText(e, "Couldn't read that dud box.") });
    }
  }

  async function reopenDudBox(boxCode: string) {
    setBoxBusy(true);
    try {
      await readJson(
        await postJson(`/api/dud-boxes/${encodeURIComponent(boxCode)}`, { status: "open" }, "PATCH"),
        "Couldn't reopen that box."
      );
      setReopenCode(null);
      await activateDudBox(boxCode);
    } catch (e) {
      setMessage({ tone: "danger", text: errorText(e, "Couldn't reopen that box.") });
    } finally {
      setBoxBusy(false);
      focusScan();
    }
  }

  // Puts units in a dud box. Returns false if it didn't save.
  async function saveDud(boxCode: string, p: Pending): Promise<boolean> {
    setSaving(true);
    try {
      const data = await readJson<{ entry: { id: string }; box: { code: string; units: number } }>(
        await postJson(`/api/dud-boxes/${encodeURIComponent(boxCode)}/entries`, {
          manifestId,
          upc: p.upc,
          quantity: p.quantity,
        }),
        "Save failed."
      );
      rememberDud({ code: data.box.code, units: data.box.units });
      setTally((t) => ({ ...t, dud: t.dud + p.quantity }));
      addToLog({
        kind: "dud",
        quantity: p.quantity,
        description: p.description,
        ref: { kind: "dud", id: data.entry.id, boxCode: data.box.code },
      });
      setMessage({ tone: "success", text: `Put ${p.quantity} in dud box ${data.box.code}. Scan the next one.` });
      setQuantity("1");
      void refreshAfterSave(p.quantity);
      return true;
    } catch (e) {
      addToLog({ kind: "dud", quantity: p.quantity, description: p.description, failed: true });
      // The box was closed (or processed) from another device: stop using
      // it and offer a new one, keeping this dud to log into it.
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        rememberDud(null);
        setPendingDud(p);
        setStarting(true);
      }
      setMessage({ tone: "danger", text: errorText(e, "Something went wrong. Try again.") });
      return false;
    } finally {
      setSaving(false);
      focusScan();
    }
  }

  async function startDudBox(print: boolean, pending = pendingDud) {
    if (!manifestId || boxBusy) return;
    setBoxBusy(true);
    try {
      const data = await readJson<{ box: { code: string }; printed: boolean; printError: string | null }>(
        await postJson("/api/dud-boxes", { manifestId, stationId: print ? stations.station?.id : null }),
        "Couldn't start a dud box."
      );
      rememberDud({ code: data.box.code, units: 0 });
      setStarting(false);
      setPickingStation(false);
      const where = data.printed
        ? `Its label is printing at ${stations.station?.name ?? "the station"}. Stick it on the box.`
        : data.printError
          ? `The label didn't print: ${data.printError}`
          : "No label printed. Reprint it when you're at a station.";
      setMessage({ tone: data.printError ? "warning" : "success", text: `Dud box ${data.box.code} started. ${where}` });
      if (pending) {
        setPendingDud(null);
        await saveDud(data.box.code, pending);
      }
    } catch (e) {
      setMessage({ tone: "danger", text: errorText(e, "Couldn't start a dud box.") });
    } finally {
      setBoxBusy(false);
      focusScan();
    }
  }

  async function closeDudBox() {
    if (!dudBox || boxBusy) return;
    setBoxBusy(true);
    try {
      await readJson(
        await postJson(`/api/dud-boxes/${encodeURIComponent(dudBox.code)}`, { status: "closed" }, "PATCH"),
        "Couldn't close the box."
      );
      setMessage({
        tone: "success",
        text: `${dudBox.code} closed. Set it aside for processing and start the next dud box.`,
      });
      rememberDud(null);
      setConfirmCloseDud(false);
      setStationFor("start");
      setStarting(true);
    } catch (e) {
      setMessage({ tone: "danger", text: errorText(e, "Couldn't close the box.") });
    } finally {
      setBoxBusy(false);
      focusScan();
    }
  }

  // Reprint the good or dud box's label at this handheld's station.
  async function reprint(which: "good" | "dud", stationId = stations.station?.id) {
    const boxCode = which === "good" ? goodBox?.code : dudBox?.code;
    if (!boxCode || boxBusy) return;
    if (!stationId) {
      setStationFor(which === "good" ? "reprint-good" : "reprint-dud");
      setPickingStation(true);
      return;
    }
    setBoxBusy(true);
    try {
      const url =
        which === "good"
          ? `/api/sort-boxes/${encodeURIComponent(boxCode)}/print`
          : `/api/dud-boxes/${encodeURIComponent(boxCode)}/print`;
      await readJson(await postJson(url, { stationId }), "Couldn't print the label.");
      const name = stations.stations?.find((s) => s.id === stationId)?.name ?? "the station";
      setMessage({ tone: "success", text: `Label for ${boxCode} is printing at ${name}.` });
    } catch (e) {
      setMessage({ tone: "danger", text: errorText(e, "Couldn't print the label.") });
    } finally {
      setBoxBusy(false);
      focusScan();
    }
  }

  // ---- Logging ---------------------------------------------------------

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
    const p: Pending = {
      code: scan.code,
      upc: line?.upc ?? scan.code,
      quantity: qty,
      description: line?.description ?? `UPC ${scan.code}`,
      extra: kind === "extra",
    };
    setMessage(null);

    if (kind === "good" || kind === "extra") {
      if (info?.sortWithoutBoxes) {
        await saveGood(null, p);
        return;
      }
      if (!goodBox) {
        // One more scan: the sort box label. These go in as soon as it's
        // active.
        setPendingGood(p);
        setMessage({ tone: "warning", text: "Scan a sort box first. These go in as soon as you scan one." });
        focusScan();
        return;
      }
      await saveGood(goodBox.code, p);
      return;
    }

    if (kind === "return") {
      setSaving(true);
      try {
        const entry = await readJson<{ id: string }>(
          await postJson("/api/sort/return", { manifestId, code: p.code, quantity: qty }),
          "Save failed."
        );
        setTally((t) => ({ ...t, return: t.return + qty }));
        addToLog({ kind, quantity: qty, description: p.description, ref: { kind: "return", id: entry.id, boxCode: null } });
        setMessage({ tone: "success", text: `Set aside ${qty} for the supplier. Scan the next one.` });
        setQuantity("1");
        void runCheck(scan.code, true);
      } catch (e) {
        addToLog({ kind, quantity: qty, description: p.description, failed: true });
        setMessage({ tone: "danger", text: errorText(e, "Something went wrong. Try again.") });
      } finally {
        setSaving(false);
        focusScan();
      }
      return;
    }

    if (kind === "dud") {
      if (dudBox) {
        await saveDud(dudBox.code, p);
        return;
      }
      // No box yet: the same tap starts one (label at this handheld's
      // station) and puts the dud in it. Without a station, it asks for
      // one first and the dud waits (scanning a DB label works too).
      if (stations.station) {
        void startDudBox(true, p);
      } else {
        setPendingDud(p);
        setStationFor("start");
        setStarting(true);
        setMessage({
          tone: "warning",
          text: "Start a dud box (or scan one). This one goes in as soon as there is one.",
        });
      }
      return;
    }

    setSaving(true);
    try {
      // Damaged and expired share the manifest's damaged tally; the note
      // keeps them apart for the numbers.
      const entry = await readJson<{ id: string }>(
        await postJson(`/api/manifests/${manifestId}/damaged`, { upc: p.upc, quantity: qty, note: kind }),
        "Save failed."
      );
      setTally((t) => ({ ...t, [kind]: t[kind] + qty }));
      addToLog({
        kind,
        quantity: qty,
        description: p.description,
        ref: { kind: "damaged", id: entry.id, boxCode: null },
      });
      setMessage({ tone: "success", text: `Logged ${qty} ${kind}. Scan the next one.` });
      setQuantity("1");
      void refreshAfterSave(qty);
    } catch (e) {
      addToLog({ kind, quantity: qty, description: p.description, failed: true });
      setMessage({ tone: "danger", text: errorText(e, "Something went wrong. Try again.") });
    } finally {
      setSaving(false);
      focusScan();
    }
  }

  async function undo(entry: LogEntry) {
    if (!entry.ref || saving) return;
    setSaving(true);
    try {
      await readJson(
        await postJson("/api/sort/undo", { kind: entry.ref.kind, id: entry.ref.id }),
        "Couldn't undo that."
      );
      setLog((prev) => prev.map((e) => (e.id === entry.id ? { ...e, undone: true } : e)));
      setTally((t) => ({ ...t, [entry.kind]: Math.max(0, t[entry.kind] - entry.quantity) }));
      const back = entry.ref.boxCode ? ` Take ${entry.quantity} back out of ${entry.ref.boxCode}.` : "";
      setMessage({ tone: "success", text: `Undone.${back}` });
      if (scan) void runCheck(scan.code, true);
      // Box unit counts on the bar.
      if (entry.ref.kind === "good" && goodBox?.code === entry.ref.boxCode) {
        const b = await readJson<SortBoxSummary>(
          await fetch(`/api/sort-boxes/${encodeURIComponent(goodBox.code)}`),
          ""
        );
        setGoodBox({ code: b.code, unitsLeft: b.unitsLeft });
      } else if (entry.ref.kind === "dud" && dudBox?.code === entry.ref.boxCode) {
        setDudBox({ code: dudBox.code, units: Math.max(0, dudBox.units - entry.quantity) });
      }
    } catch (e) {
      setMessage({ tone: "danger", text: errorText(e, "Couldn't undo that.") });
    } finally {
      setSaving(false);
      focusScan();
    }
  }

  // Owner: this load is sorted without sort boxes (or with them again).
  async function setNoBoxes(on: boolean) {
    if (!manifestId) return;
    setSaving(true);
    try {
      const d = await readJson<{ sortWithoutBoxes: boolean }>(
        await postJson("/api/sort/no-boxes", { manifestId, on }),
        "Couldn't change that."
      );
      setInfo((i) => (i ? { ...i, sortWithoutBoxes: d.sortWithoutBoxes } : i));
      setPendingGood(null);
      setMessage({
        tone: "success",
        text: d.sortWithoutBoxes ? "This load is sorted without sort boxes now. Good just counts them in." : "This load uses sort boxes again.",
      });
    } catch (e) {
      setMessage({ tone: "danger", text: errorText(e, "Couldn't change that.") });
    } finally {
      setSaving(false);
      focusScan();
    }
  }

  async function askDone() {
    if (!manifestId) return;
    setOtherSorters(null);
    setConfirmDone(true);
    try {
      const d = await readJson<{ others: { username: string; lastAt: string }[] }>(
        await fetch(`/api/sort/done?manifestId=${encodeURIComponent(manifestId)}`),
        ""
      );
      const now = Date.now();
      setOtherSorters(d.others.map((o) => ({ username: o.username, ago: minutesAgo(now - new Date(o.lastAt).getTime()) })));
    } catch {
      // Can't tell: the popup still asks, just without names.
      setOtherSorters([]);
    }
  }

  async function markDone(reopen: boolean) {
    if (!manifestId) return;
    setSaving(true);
    try {
      const d = await readJson<{ sortedAt: string | null; sortedBy: string | null }>(
        await postJson("/api/sort/done", { manifestId, undo: reopen }),
        "Couldn't save that."
      );
      setInfo((i) => (i ? { ...i, sortedAt: d.sortedAt, sortedBy: d.sortedBy } : i));
      setConfirmDone(false);
      setMessage({
        tone: "success",
        text: reopen ? "Sorting is open again." : "Sorting done. The manifest page now shows what's short or over.",
      });
    } catch (e) {
      setMessage({ tone: "danger", text: errorText(e, "Couldn't save that.") });
    } finally {
      setSaving(false);
    }
  }

  if (!manifestId) {
    return (
      <AppShell width="narrow" title="Sort" subtitle="Sort the whole load into boxes before listing. Pick the load.">
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
        <Link href="/sort/boxes" className={cn(buttonClasses({ variant: "ghost" }), "mt-4")}>
          <Boxes className="size-4" aria-hidden />
          Sort boxes
        </Link>
      </AppShell>
    );
  }

  const result = scan?.result ?? null;
  const line = result?.line ?? null;
  const isDud = Boolean(line && result?.dud);
  const consignment = info?.consignment ?? result?.consignment ?? false;
  const noBoxes = info?.sortWithoutBoxes ?? result?.sortWithoutBoxes ?? false;
  const itemNumbers = (info?.itemNumberLines ?? 0) > 0;
  // Consignment: this one goes back to the supplier (the pick list said
  // leave it, or it isn't on the manifest).
  const goesBack = Boolean(consignment && result && (!line || result.consignmentCall?.decision === "leave"));
  const showActions = Boolean(scan && !scan.loading && result);
  const stationList = stations.stations;
  // Unknown while loading counts as "has stations" so the no-label button
  // doesn't flash; a failed load counts as none so a box can still start.
  const hasStations = stations.error ? false : stationList == null || stationList.length > 0;
  const showStationPicker = pickingStation || (starting && stations.needsStation && hasStations);
  const undoable = log.find((e) => e.ref && !e.failed && !e.undone);
  // The third small button next to Damaged / Expired: the other way this
  // one can go, if any.
  const otherAction: { kind: Kind; label: string } | null = consignment
    ? goesBack
      ? // Keeping one that goes back is Cristian's call, not a sorter's.
        isOwner
        ? { kind: line ? "good" : "extra", label: "Keep it" }
        : null
      : { kind: "return", label: "To supplier" }
    : !isDud
      ? { kind: "dud", label: "Dud box" }
      : null;

  return (
    // Laid out to fit one handheld screen (about 360x620) from the scan
    // down to the action buttons, so nobody scrolls between scans
    // (Cristian, 2026-10-24): a one-line header instead of the page title,
    // small tallies, the scan field without its label and hint once
    // something's scanned, and damaged/expired/the other option in one row.
    <AppShell focused width="narrow">
      <div className="-mt-2 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Sort</p>
            <p className="truncate text-sm font-semibold text-foreground">
              {info ? info.title : loadError ? "Can't open this load" : "Loading…"}
            </p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => pickManifest(null)}>
            Change load
          </Button>
        </div>

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

        {(!noBoxes || !consignment) && (
          <ActiveBoxesBar
            showGood={!noBoxes}
            showDud={!consignment}
            goodBox={goodBox}
            goodChecked={goodChecked}
            dudBox={dudBox}
            dudChecked={dudChecked}
            busy={boxBusy}
            confirmCloseDud={confirmCloseDud}
            onGoodFull={goodBoxFull}
            onDudFull={() => setConfirmCloseDud(true)}
            onCancelCloseDud={() => setConfirmCloseDud(false)}
            onCloseDud={closeDudBox}
            onStartDud={() => {
              setStationFor("start");
              setStarting(true);
            }}
            onReprint={(which) => reprint(which)}
          />
        )}

        <div className="grid grid-cols-5 gap-1 text-center">
          <TallyTile label="Good" value={tally.good} tone="success" />
          <TallyTile label="Extra" value={tally.extra} tone="primary" />
          {consignment ? (
            <TallyTile label="Return" value={tally.return} tone="warning" />
          ) : (
            <TallyTile label="Dud" value={tally.dud} tone="warning" />
          )}
          <TallyTile label="Damaged" value={tally.damaged} tone="danger" />
          <TallyTile label="Expired" value={tally.expired} tone="danger" />
        </div>

        {/* Only before the first scan: it's the same every time. */}
        {!scan && info?.consignment && (
          <p className="text-sm text-muted-foreground">
            Consignment load: count everything the supplier delivered. If the screen says it goes back, set it aside
            for the supplier.
          </p>
        )}
        {!scan && itemNumbers && (
          <p className="text-sm text-muted-foreground">
            No barcode on it? Tap the keyboard button next to the scan box and type its Item #.
          </p>
        )}
        {!scan && noBoxes && (
          <p className="text-sm text-muted-foreground">No sort boxes on this load: Good just counts them in.</p>
        )}

        {!scan && info && !info.evaluated && !info.consignment && (
          <p className="text-sm text-muted-foreground">
            This load never went through the Analyzer, so nothing is called a dud for you. Use the dud box for anything
            that clearly won&apos;t sell.
          </p>
        )}

        <ScanField
          id="sort-upc"
          label="UPC"
          prompt={itemNumbers ? "Scan the UPC, or type the Item # (keyboard button)" : "Scan the item's UPC"}
          // Item #s can have letters (L14541): the full keyboard when the
          // load has products typed in by Item #.
          numeric={!itemNumbers}
          autoFocus
          compact={Boolean(scan)}
          value={code}
          onChange={setCode}
          onScan={handleScan}
          hint={
            noBoxes
              ? consignment
                ? "Scan each item."
                : "Scan each item, or a dud box (DB) label to switch dud boxes."
              : "Scan a sort box (SB) or dud box (DB) label to switch boxes."
          }
        />

        {scan?.loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Checking {scan.code}…
          </p>
        )}

        {scan?.error && <Alert tone="danger">{scan.error}</Alert>}

        {scan && result && !line && (
          <div role="alert" className="rounded-xl border-2 border-red-300 bg-red-50 p-3 text-red-950">
            <div className="flex gap-2">
              <SearchX className="mt-0.5 size-6 shrink-0 text-red-600" aria-hidden />
              <div className="min-w-0">
                <p className="text-lg font-semibold leading-tight">Not on this manifest</p>
                <p className="mt-0.5 break-all text-xs tabular-nums text-red-900/80">Scanned: {scan.code}</p>
                <p className="mt-1 text-sm">
                  {consignment
                    ? "It wasn't on the supplier's list. Set it aside to go back to the supplier."
                    : noBoxes
                      ? "If it's good, count it in as an extra. Otherwise log it below."
                      : "If it's good, box it as an extra. Otherwise log it below."}
                </p>
                {result.extraSorted > 0 && (
                  <p className="mt-1 text-sm font-medium">Already counted as extra on this load: {result.extraSorted}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {line && isDud && (
          <div role="alert" className="rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-amber-950">
            <div className="flex gap-2.5">
              <Ban className="mt-0.5 size-7 shrink-0 text-amber-600" aria-hidden />
              <div className="min-w-0">
                <p className="text-xl font-bold leading-tight">DUD: put it in the dud box</p>
                {result?.dudReason && <p className="mt-0.5 text-sm font-medium">{result.dudReason}</p>}
                <p className="mt-1 text-sm">
                  {dudBox ? (
                    <>
                      Dud box <span className="font-mono font-bold">{dudBox.code}</span>
                    </>
                  ) : (
                    "No dud box yet. Tapping below starts one."
                  )}
                </p>
              </div>
            </div>
          </div>
        )}

        {line && goesBack && (
          <div role="alert" className="rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-amber-950">
            <div className="flex gap-2.5">
              <Ban className="mt-0.5 size-7 shrink-0 text-amber-600" aria-hidden />
              <div className="min-w-0">
                <p className="text-xl font-bold leading-tight">DON&apos;T KEEP: set it aside for the supplier</p>
                <p className="mt-0.5 text-sm font-medium">
                  {result?.consignmentCall?.reason ?? "It wasn't supposed to come with this load. It goes back."}
                </p>
              </div>
            </div>
          </div>
        )}

        {line && (
          <Card padded={false} className="p-3">
            <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{line.description}</p>
            <p className="text-xs tabular-nums text-muted-foreground">{keyLabel(line.upc)}</p>
            <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
              <Count label="Expected" value={line.expected} />
              <Count label="Sorted" value={line.sorted} />
              <Count label="Damaged" value={line.damaged} />
              {consignment ? (
                <Count label="To supplier" value={line.returned} />
              ) : (
                <Count label="Dud" value={line.dudLogged} />
              )}
            </div>
            {consignment && result?.consignmentCall?.decision === "leave" ? (
              line.over > 0 ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-danger">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {line.over} kept anyway.
                </p>
              ) : null
            ) : line.over > 0 ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-danger">
                <TriangleAlert className="size-4 shrink-0" aria-hidden />
                Over by {line.over}: more than the manifest listed.
              </p>
            ) : (
              <p className={cn("mt-1.5 text-sm font-medium", line.leftToSort > 0 ? "text-foreground" : "text-warning")}>
                {line.leftToSort > 0
                  ? `${line.leftToSort} left to sort`
                  : "All of these are sorted. Any more would be over."}
              </p>
            )}
            {!isDud && result?.dudReason && <p className="mt-0.5 text-xs text-muted-foreground">{result.dudReason}</p>}
          </Card>
        )}

        {showActions && scan && result && (
          <>
            <div className="grid grid-cols-[auto_3rem_1fr_3rem] items-center gap-2">
              <span className="text-sm font-medium text-foreground">How many</span>
              <Button
                variant="outline"
                size="lg"
                className="px-0"
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
                aria-label="How many"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
              />
              <Button
                variant="outline"
                size="lg"
                className="px-0"
                aria-label="One more"
                onClick={() => setQuantity((q) => String((Number(q) || 0) + 1))}
              >
                <Plus className="size-5" aria-hidden />
              </Button>
            </div>

            {goesBack ? (
              <Button variant="warning" size="xl" block onClick={() => record("return")} disabled={saving}>
                <PackageX className="size-5" aria-hidden />
                Set aside for the supplier
              </Button>
            ) : isDud ? (
              <Button variant="warning" size="xl" block onClick={() => record("dud")} disabled={saving || boxBusy}>
                <PackageX className="size-5" aria-hidden />
                {dudBox ? `Put in dud box ${dudBox.code}` : "Start a dud box"}
              </Button>
            ) : line ? (
              <Button variant="success" size="xl" block onClick={() => record("good")} disabled={saving}>
                <ThumbsUp className="size-5" aria-hidden />
                {noBoxes ? "Good, count it in" : goodBox ? `Good, into ${goodBox.code}` : "Good, pass to lister"}
              </Button>
            ) : (
              <Button variant="success" size="xl" block onClick={() => record("extra")} disabled={saving}>
                <PackageCheck className="size-5" aria-hidden />
                {noBoxes ? "Count it in as extra" : goodBox ? `Box it as extra, into ${goodBox.code}` : "Box it as extra"}
              </Button>
            )}
            <div className={cn("grid gap-2", otherAction ? "grid-cols-3" : "grid-cols-2")}>
              <Button
                variant="danger-ghost"
                size="md"
                className="border border-red-200 px-1"
                onClick={() => record("damaged")}
                disabled={saving}
              >
                {isDud ? "It's damaged" : "Damaged"}
              </Button>
              <Button
                variant="danger-ghost"
                size="md"
                className="border border-red-200 px-1"
                onClick={() => record("expired")}
                disabled={saving}
              >
                {isDud ? "It's expired" : "Expired"}
              </Button>
              {otherAction && (
                <Button
                  variant="outline"
                  size="md"
                  className="px-1"
                  onClick={() => record(otherAction.kind)}
                  disabled={saving || (otherAction.kind === "dud" && boxBusy)}
                >
                  {otherAction.label}
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
                <Button variant="warning" size="sm" onClick={() => reopenDudBox(reopenCode)} disabled={boxBusy}>
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

        <div id="sort-box-panel">
          {showStationPicker ? (
            <StationPicker
              stations={stations.stations}
              selectedId={stations.station?.id ?? null}
              error={stations.error}
              onPick={(s) => {
                stations.choose(s.id);
                setPickingStation(false);
                if (stationFor === "reprint-good") void reprint("good", s.id);
                if (stationFor === "reprint-dud") void reprint("dud", s.id);
              }}
              onCancel={() => {
                setPickingStation(false);
                if (!stations.station) setStarting(false);
              }}
              onReload={stations.reload}
            />
          ) : (
            starting &&
            !dudBox && (
              <StartDudBoxCard
                openBoxes={openDudBoxes}
                busy={boxBusy}
                stationName={stations.station?.name ?? null}
                hasStations={hasStations}
                pendingDud={pendingDud != null}
                onUse={(c) => activateDudBox(c)}
                onChangeStation={() => {
                  setStationFor("start");
                  setPickingStation(true);
                }}
                onConfirmStart={(print) => startDudBox(print)}
                onCancel={() => {
                  setStarting(false);
                  setPendingDud(null);
                }}
              />
            )
          )}
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
                      e.failed || e.undone
                        ? "text-muted-foreground line-through"
                        : e.kind === "good" || e.kind === "extra"
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
                  {e.undone && <span className="shrink-0 text-xs text-muted-foreground">Undone</span>}
                  {undoable?.id === e.id && (
                    <Button variant="ghost" size="sm" onClick={() => undo(e)} disabled={saving}>
                      <Undo2 className="size-4" aria-hidden />
                      Undo
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <SortingDoneCard
          sortedAt={info?.sortedAt ?? null}
          sortedBy={info?.sortedBy ?? null}
          confirming={confirmDone}
          others={otherSorters}
          busy={saving}
          isOwner={isOwner}
          onAsk={() => void askDone()}
          onCancel={() => setConfirmDone(false)}
          onDone={() => markDone(false)}
          onReopen={() => markDone(true)}
        />

        {!noBoxes && (
          <Link href="/sort/boxes" className={buttonClasses({ variant: "ghost" })}>
            <Boxes className="size-4" aria-hidden />
            Sort boxes
          </Link>
        )}
        {isOwner && info && (
          <Button variant="ghost" size="sm" onClick={() => setNoBoxes(!noBoxes)} disabled={saving}>
            {noBoxes ? "Use sort boxes for this load" : "Sort this load without sort boxes"}
          </Button>
        )}
      </div>
    </AppShell>
  );
}

// The two boxes the sorter is filling, side by side, always on screen. Each
// has its own "full" button that leaves the other alone.
function ActiveBoxesBar(props: {
  // Loads sorted without sort boxes have no good box; consignment loads
  // have no dud box.
  showGood: boolean;
  showDud: boolean;
  goodBox: SortBoxState | null;
  goodChecked: boolean;
  dudBox: DudBoxState | null;
  dudChecked: boolean;
  busy: boolean;
  confirmCloseDud: boolean;
  onGoodFull: () => void;
  onDudFull: () => void;
  onCancelCloseDud: () => void;
  onCloseDud: () => void;
  onStartDud: () => void;
  onReprint: (which: "good" | "dud") => void;
}) {
  return (
    <Card padded={false}>
      <div
        className={cn("grid divide-x divide-border", props.showGood && props.showDud ? "grid-cols-2" : "grid-cols-1")}
      >
        {props.showGood && (
          <BoxSlot
            label="Good"
            icon={<PackageCheck className="size-4 text-success" aria-hidden />}
            code={props.goodBox?.code ?? null}
            units={props.goodBox?.unitsLeft ?? 0}
            checked={props.goodChecked}
            emptyText="None. Scan a sort box."
            busy={props.busy}
            onFull={props.onGoodFull}
            onReprint={() => props.onReprint("good")}
          />
        )}
        {props.showDud && (
          <BoxSlot
            label="Dud"
            icon={<PackageX className="size-4 text-amber-600" aria-hidden />}
            code={props.dudBox?.code ?? null}
            units={props.dudBox?.units ?? 0}
            checked={props.dudChecked}
            emptyText="None. Scan one or start one."
            busy={props.busy}
            onFull={props.onDudFull}
            onReprint={() => props.onReprint("dud")}
            onStart={props.onStartDud}
          />
        )}
      </div>
      {props.confirmCloseDud && props.dudBox && (
        <div className="border-t border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-950">
            Close {props.dudBox.code}? It goes aside for processing and you start a new dud box.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="warning" onClick={props.onCloseDud} disabled={props.busy}>
              Yes, it&apos;s full
            </Button>
            <Button variant="outline" onClick={props.onCancelCloseDud} disabled={props.busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function BoxSlot(props: {
  label: string;
  icon: ReactNode;
  code: string | null;
  units: number;
  checked: boolean;
  emptyText: string;
  busy: boolean;
  onFull: () => void;
  onReprint: () => void;
  onStart?: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {props.icon}
        {props.label}
      </p>
      {!props.checked ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Checking…
        </p>
      ) : props.code ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-mono text-xl font-bold leading-none text-foreground">{props.code}</p>
            <p className="shrink-0 text-xs tabular-nums text-muted-foreground">{props.units} in it</p>
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" className="flex-1 px-2" onClick={props.onFull} disabled={props.busy}>
              Full, new one
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="px-2"
              aria-label={`Reprint ${props.code} label`}
              onClick={props.onReprint}
              disabled={props.busy}
            >
              <Printer className="size-4" aria-hidden />
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-warning">{props.emptyText}</p>
          {props.onStart && (
            <Button variant="outline" size="sm" onClick={props.onStart} disabled={props.busy}>
              <PackageOpen className="size-4" aria-hidden />
              Start one
            </Button>
          )}
        </>
      )}
    </div>
  );
}

// Starting a new dud box: use an open one of this load, or start one with
// its label printed at this handheld's station.
function StartDudBoxCard(props: {
  openBoxes: DudBoxSummary[];
  busy: boolean;
  stationName: string | null;
  hasStations: boolean;
  pendingDud: boolean;
  onUse: (code: string) => void;
  onChangeStation: () => void;
  onConfirmStart: (print: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <Card className="border-amber-300">
      <SectionHeader
        title="Start a dud box"
        description={
          props.pendingDud
            ? "The dud you just scanned goes in it right away."
            : "Grab an empty box. Its label prints now. Or scan a dud box label."
        }
      />
      {props.openBoxes.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Already open for this load</p>
          <ul className="flex flex-col gap-2">
            {props.openBoxes.map((b) => (
              <li key={b.code}>
                <Button
                  variant="outline"
                  block
                  onClick={() => props.onUse(b.code)}
                  disabled={props.busy}
                  className="justify-between"
                >
                  <span className="font-mono font-bold">{b.code}</span>
                  <span className="text-sm text-muted-foreground">
                    {b.units} {b.units === 1 ? "unit" : "units"} · Use it
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
        <Button variant="ghost" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

// "Sorting done": the whole load has been through. After that, lines with
// nothing sorted count as short on the manifest page. Only the owner can
// reopen it.
function SortingDoneCard(props: {
  sortedAt: string | null;
  sortedBy: string | null;
  confirming: boolean;
  others: OtherSorter[] | null;
  busy: boolean;
  isOwner: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onDone: () => void;
  onReopen: () => void;
}) {
  if (props.sortedAt) {
    return (
      <Card>
        <p className="flex items-center gap-2 text-sm font-medium text-success">
          <CircleCheck className="size-5 shrink-0" aria-hidden />
          Sorting finished {new Date(props.sortedAt).toLocaleString()}
          {props.sortedBy ? ` by ${props.sortedBy}` : ""}
        </p>
        {props.isOwner && (
          <Button variant="ghost" size="sm" className="mt-2" onClick={props.onReopen} disabled={props.busy}>
            Reopen sorting
          </Button>
        )}
      </Card>
    );
  }
  return (
    <>
      <Button variant="outline" size="lg" block onClick={props.onAsk}>
        <CircleCheck className="size-5" aria-hidden />
        Sorting done
      </Button>
      {props.confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sort-done-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
        >
          <div className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl">
            <p id="sort-done-title" className="text-xl font-bold leading-tight text-foreground">
              Is everyone done sorting this load?
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Check with everyone sorting it first. Once it&apos;s marked done, anything not sorted yet counts as short
              on the manifest.
            </p>
            {props.others === null ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden /> Checking who else is sorting…
              </p>
            ) : (
              props.others.length > 0 && (
                <div className="mt-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-amber-950">
                  <p className="flex items-center gap-1.5 text-sm font-semibold">
                    <TriangleAlert className="size-4 shrink-0" aria-hidden />
                    Still scanning this load lately:
                  </p>
                  <ul className="mt-1 text-sm">
                    {props.others.map((o) => (
                      <li key={o.username}>
                        <span className="font-semibold">{o.username}</span> · {o.ago}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button variant="primary" size="lg" onClick={props.onDone} disabled={props.busy || props.others === null}>
                Yes, everyone&apos;s done
              </Button>
              <Button variant="outline" size="lg" onClick={props.onCancel} disabled={props.busy}>
                Not yet
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type OtherSorter = { username: string; ago: string };

function minutesAgo(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? "just now" : `${m} min ago`;
}

const TALLY_TONES = {
  success: "border-green-200 bg-green-50 text-green-800",
  primary: "border-blue-200 bg-blue-50 text-blue-800",
  danger: "border-red-200 bg-red-50 text-red-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
} as const;

function TallyTile({ label, value, tone }: { label: string; value: number; tone: keyof typeof TALLY_TONES }) {
  return (
    <div className={cn("rounded-lg border px-0.5 py-0.5", TALLY_TONES[tone])}>
      <p className="truncate text-[10px] font-medium leading-tight">{label}</p>
      <p className="text-base font-semibold leading-tight tabular-nums">{value}</p>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-background px-0.5 py-1">
      <p className="truncate text-[10px] font-medium leading-tight text-muted-foreground">{label}</p>
      <p className="text-base font-semibold leading-tight tabular-nums text-foreground">{value}</p>
    </div>
  );
}
