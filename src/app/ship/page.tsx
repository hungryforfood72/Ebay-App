"use client";

import { ScanField } from "@/components/ScanField";
import { useCurrentUser } from "@/components/UserNav";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { upcMatchKeys } from "@/lib/upcMatch";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import { printPage } from "@/lib/warehouse/labelPrint";
import type { SlipResult } from "@/lib/warehouse/packingSlip";
import type {
  ExpectedItem,
  PickLine,
  PickResponse,
  ScannedItem,
  ShipOrdersResponse,
  UnpickResponse,
} from "@/lib/warehouse/picking";
import { ChevronDown, CircleCheck, CircleX, ExternalLink, Info, MapPin, PackageCheck, RefreshCw, Undo2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Order picking on the handheld. Scan an item's label and the page works out
// which open order needs it (the oldest, if several do), checks it on the
// server and says right or wrong, loud enough to hear without looking. Tap a
// line first to check a scan against that line only. Lines are in walking
// order: shelf, then bin.

const SCAN_ID = "ship-code";
const AUTO_REFRESH_MS = 60_000;

type Result = {
  tone: "good" | "bad" | "info";
  headline: string;
  detail?: string;
  note?: string | null;
  // The line a successful pick went to, for the Undo button.
  undoLine?: PickLine;
  // Another button (Print again on a label that already printed).
  action?: { label: string; run: () => void };
};

// What the pick slip's barcode holds for an eBay order: its order number.
// Labels print from the Shipping page now; scanned here, it says so.
const EBAY_ORDER_RE = /^\d{2}-\d{5}-\d{5}$/;

// Short tone so the answer registers without looking at the screen. Same
// pattern as the consignment pick page: one high beep for right, two low
// ones for wrong.
function beep(kind: "good" | "bad" | "info") {
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
    navigator.vibrate?.(kind === "good" ? 80 : kind === "bad" ? [80, 60, 80] : 40);
  } catch {
    // No audio (or no permission yet) is fine: the screen shows the answer.
  }
}

function focusScan() {
  setTimeout(() => document.getElementById(SCAN_ID)?.focus(), 0);
}

const isLabelCode = (code: string) => classifyScan(code) === "item";
const isOpen = (l: PickLine) => l.item != null && l.status !== "va" && l.picked < l.quantity;
const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// "ES000456 (Neutrogena 3-pack, exp 05/2027)". Old items have no readable
// code, so just the name.
function describe(x: ScannedItem | ExpectedItem): string {
  const bits = [short(x.title), x.expiration ? `exp ${x.expiration}` : null, x.condition && x.condition !== "New" ? x.condition : null]
    .filter(Boolean)
    .join(", ");
  return isLabelCode(x.code) ? `${x.code} (${bits})` : bits;
}

// Where a wrongly grabbed item goes back. formatLocation says "Not in a
// bin yet" for labelled stock that hasn't been binned: that's the table.
function putBack(location: string): string {
  return location === "Not in a bin yet" ? "Put it back on the binning table." : `Put it back: ${location}.`;
}

function placeText(l: PickLine): string {
  if (l.grabFrom.binCode) {
    return l.grabFrom.shelf ? `Shelf ${l.grabFrom.shelf} · ${l.grabFrom.binCode}` : `${l.grabFrom.binCode} (not on a shelf)`;
  }
  if (l.grabFrom.binningTable) return "Not in a bin yet: check the binning table";
  if (l.grabFrom.shelf) return `Shelf ${l.grabFrom.shelf}`;
  return "No location on record";
}

function orderLabel(l: Pick<PickLine, "orderNumber" | "buyer" | "source">): string {
  const who = l.buyer ? ` · ${l.buyer}` : "";
  const where = l.source === "eBay" ? "" : ` (${l.source})`;
  return `Order ${l.orderNumber}${where}${who}`;
}

// Open lines that this scan could be for, oldest order first. A label
// matches by code; a UPC only matches old items, which have no label.
// Counter sales go last: a unit in someone's hand is for an order still to
// go out, since a counter sale's unit already left with the customer.
function linesForScan(lines: PickLine[], code: string): PickLine[] {
  const keys = classifyScan(code) === "upc" ? new Set(upcMatchKeys(code)) : null;
  return lines
    .filter(
      (l) =>
        isOpen(l) &&
        l.item != null &&
        (normalizeCode(l.item.code) === code || (keys != null && l.verifyBy === "upc" && l.item.upcKeys.some((k) => keys.has(k))))
    )
    .sort((a, b) => Number(a.handoff === "counter") - Number(b.handoff === "counter") || a.orderedAt.localeCompare(b.orderedAt));
}

type OrderGroup = {
  key: string;
  orderNumber: string;
  buyer: string | null;
  source: string;
  pickup: boolean;
  delivery: boolean;
  // Other open orders that ship in the same box (same eBay buyer, same
  // address).
  combineWith: string[];
  lines: PickLine[];
};

// One box on Ready to pack: an order, or a ship-together group of them.
// waitingOn: orders in the group not picked yet, so the box waits.
type PackCard = { key: string; orders: OrderGroup[]; waitingOn: string[] };

const orderList = (numbers: string[]) => numbers.join(" and ");

// One line for the pick result about the order's packing slip.
function slipNote(slip: SlipResult | null | undefined): string | null {
  if (!slip) return null;
  if (slip.status === "queued") {
    const where = slip.online ? `printing at ${slip.station}` : `sent to ${slip.station} (its page isn't open, it prints when it is)`;
    const label = slip.delivery === false ? " The delivery label didn't print: no address yet, print it from Deliveries." : slip.delivery ? " Delivery label too." : "";
    return `Packing slip ${where}.${label}`;
  }
  if (slip.status === "no_station") return "No packing station is set up: tap Packing slip under Ready to pack to print it.";
  if (slip.status === "hold_for_combine") {
    return `Same buyer has order ${orderList(slip.waitingOn)} still to pick. One packing slip prints once that's picked too.`;
  }
  return null;
}

export default function ShipPage() {
  const router = useRouter();
  const [data, setData] = useState<ShipOrdersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [code, setCode] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [slipBusy, setSlipBusy] = useState<string | null>(null);
  const [slipMessage, setSlipMessage] = useState<{ key: string; text: string } | null>(null);

  // Packing slip button on Ready to pack: to the packing station, or
  // printed right here when there isn't one.
  async function reprintSlip(order: Pick<OrderGroup, "key" | "lines">) {
    const line = order.lines[0];
    if (!line) return;
    setSlipBusy(order.key);
    setSlipMessage(null);
    try {
      const res = await fetch("/api/ship/packing-slip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: line.channel, orderId: line.orderId }),
      });
      const json = (await res.json()) as SlipResult | { error: string };
      if (!res.ok || "error" in json) throw new Error("error" in json ? json.error : "Couldn't print the packing slip.");
      if (json.status === "print_here") {
        for (const page of json.pages) await printPage(page, { width: "4in", height: "6in" });
        setSlipMessage({ key: order.key, text: "Sent to this device's printer (no packing station is set up)." });
      } else {
        setSlipMessage({ key: order.key, text: slipNote(json) ?? "That order isn't open any more." });
      }
    } catch (e) {
      setSlipMessage({ key: order.key, text: e instanceof Error ? e.message : "Couldn't print the packing slip." });
    } finally {
      setSlipBusy(null);
    }
  }
  const [currentBin, setCurrentBin] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const me = useCurrentUser()?.username ?? null;
  const [showDone, setShowDone] = useState(false);
  const [showVa, setShowVa] = useState(false);
  const busyRef = useRef(false);

  const load = useCallback(async (fresh: boolean) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/ship/orders${fresh ? "?fresh=1" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't load orders.");
      setData(json as ShipOrdersResponse);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load orders.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Kicks off the first load; setState happens after the fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(false);
    // New orders come in while people pick. Skip a refresh mid-scan so the
    // list doesn't shift under a pick that's being saved.
    const timer = setInterval(() => {
      if (!document.hidden && !busyRef.current) load(false);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The scanner types into whatever has focus. If someone tapped a button,
  // send the next scan to the scan field instead of losing it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) document.getElementById(SCAN_ID)?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lines = useMemo(() => data?.lines ?? [], [data]);
  const inApp = lines.filter((l) => l.item != null && l.status !== "va");
  // Counter sales get their own small section: nothing to pack, just clear
  // the unit off its bin's count. Pickups stay in the walk with the rest,
  // since their bag still has to come off the shelf.
  const counterLines = inApp.filter((l) => l.handoff === "counter" && isOpen(l));
  const toPick = inApp.filter((l) => l.handoff !== "counter");
  const openLines = toPick.filter(isOpen);
  const doneLines = inApp.filter((l) => l.picked > 0);
  // A counter sale that isn't in the app has no bin count to clear.
  const findYourself = lines.filter((l) => l.status === "not_in_app" && l.handoff !== "counter");
  const vaLines = lines.filter((l) => l.status === "va");
  const unitsLeft = openLines.reduce((n, l) => n + (l.quantity - l.picked), 0);
  const unitsDone = toPick.reduce((n, l) => n + Math.min(l.picked, l.quantity), 0);
  const selected = lines.find((l) => l.key === selectedKey && isOpen(l)) ?? null;
  const nextUp = selected ?? openLines.find((l) => !l.cancelRequested) ?? null;

  // An order is ready to pack once every line the app can check is picked.
  // Lines it can't check (not in the app) are listed as a reminder.
  const orders = useMemo(() => {
    const map = new Map<string, OrderGroup>();
    for (const l of lines) {
      if (l.status === "va" || l.handoff === "counter") continue;
      const key = `${l.channel}:${l.orderId}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          orderNumber: l.orderNumber,
          buyer: l.buyer,
          source: l.source,
          pickup: l.handoff === "pickup",
          delivery: l.handoff === "delivery",
          combineWith: l.combineWith,
          lines: [],
        });
      }
      map.get(key)!.lines.push(l);
    }
    return [...map.values()];
  }, [lines]);
  const readyToPack = orders.filter((o) => {
    const checkable = o.lines.filter((l) => l.item != null);
    return checkable.length > 0 && checkable.every((l) => l.picked >= l.quantity);
  });
  // Ship-together orders share one card, shown once any of them is picked.
  // An order with nothing the app can check never holds the others up.
  const packCards: PackCard[] = [];
  {
    const ready = new Set(readyToPack.map((o) => o.key));
    const byNumber = new Map(orders.map((o) => [o.orderNumber, o]));
    const seen = new Set<string>();
    for (const o of readyToPack) {
      if (seen.has(o.key)) continue;
      const members = [o.orderNumber, ...o.combineWith]
        .map((n) => byNumber.get(n))
        .filter((m): m is OrderGroup => m != null)
        .sort((a, b) => (a.lines[0]?.orderedAt ?? "").localeCompare(b.lines[0]?.orderedAt ?? ""));
      for (const m of members) seen.add(m.key);
      const waitingOn = members.filter((m) => !ready.has(m.key) && m.lines.some((l) => l.item != null)).map((m) => m.orderNumber);
      packCards.push({ key: members.map((m) => m.key).join("+"), orders: members, waitingOn });
    }
  }
  const boxesReady = packCards.filter((c) => c.waitingOn.length === 0).length;

  function updateLine(key: string, patch: Partial<PickLine>) {
    setData((d) => (d ? { ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) } : d));
  }

  function show(r: Result) {
    setResult(r);
    beep(r.tone);
  }

  async function submitPick(line: PickLine, scannedCode: string, manual = false) {
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/ship/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: line.orderId,
          channel: line.channel,
          lineItemId: line.lineItemId,
          scannedCode,
          binCode: currentBin,
          manual,
        }),
      });
      const json = (await res.json()) as (PickResponse & { slip?: SlipResult | null }) | { error: string };
      if (!res.ok || "error" in json) throw new Error("error" in json ? json.error : "Couldn't save the pick.");
      if (json.ok) {
        const pickedBy = me && !line.pickedBy.includes(me) ? [...line.pickedBy, me] : line.pickedBy;
        updateLine(line.key, { picked: json.picked, pickedBy });
        const orderLines = lines.filter((l) => l.orderId === line.orderId && l.channel === line.channel && l.item != null);
        const orderDone = orderLines.every((l) => (l.key === line.key ? json.picked : l.picked) >= l.quantity);
        const holdFor = json.slip?.status === "hold_for_combine" ? json.slip.waitingOn : null;
        const more = json.quantity - json.picked;
        setSelectedKey(null);
        const count =
          more > 0 ? `${json.picked} of ${json.quantity} picked. Grab ${more} more.` : `${json.picked} of ${json.quantity} picked.`;
        show({
          tone: "good",
          headline:
            line.handoff === "counter"
              ? "Cleared from the bins"
              : line.handoff === "pickup"
                ? `Correct, set it aside for pickup (order ${line.orderNumber})`
                : line.handoff === "delivery"
                  ? `Correct, set it aside for local delivery (order ${line.orderNumber})`
                  : `Correct, put it with order ${line.orderNumber}`,
          detail:
            line.handoff === "counter"
              ? `Counter sale ${line.orderNumber}. ${more > 0 ? `${more} more to clear.` : "All cleared."}`
              : orderDone
                ? line.handoff === "pickup"
                  ? `Order ${line.orderNumber} is ready for pickup.`
                  : line.handoff === "delivery"
                    ? `Order ${line.orderNumber} is ready for local delivery. No label needed.`
                    : holdFor
                      ? `Order ${line.orderNumber} is picked. Don't pack it yet: it ships with order ${orderList(holdFor)}.`
                      : `Order ${line.orderNumber} is ready to pack.`
                : count,
          note: [json.manual ? "Confirmed by tap, not a scan." : null, json.binNote, slipNote(json.slip)].filter(Boolean).join(" ") || null,
          undoLine: { ...line, picked: json.picked },
        });
      } else if (json.code === "already_picked") {
        updateLine(line.key, { picked: json.picked ?? line.picked });
        show({ tone: "bad", headline: "Already picked", detail: `All ${json.quantity ?? line.quantity} for order ${line.orderNumber} are picked already.` });
      } else if (json.code === "wrong_item") {
        const need = json.expected ? `You need ${describe(json.expected)}.` : "";
        show({
          tone: "bad",
          headline: "Wrong item",
          detail: json.scannedItem ? `That's ${describe(json.scannedItem)}. ${need}` : `${json.reason}. ${need}`,
          note: json.scannedItem ? putBack(json.scannedItem.location) : null,
        });
      } else {
        show({ tone: "bad", headline: json.code === "not_open" ? "Not open any more" : "Wrong item", detail: json.reason });
        if (json.code === "not_open") load(true);
      }
    } catch (e) {
      show({ tone: "bad", headline: "Didn't save", detail: e instanceof Error ? e.message : "Try that scan again." });
    } finally {
      busyRef.current = false;
      setBusy(false);
      focusScan();
    }
  }

  async function handleScan(raw: string) {
    const scanned = normalizeCode(raw);
    setCode("");
    if (!scanned || busyRef.current || !data) return;
    const kind = classifyScan(scanned);

    // A pick slip: its label prints from the Shipping page.
    if (EBAY_ORDER_RE.test(scanned)) {
      show({
        tone: "info",
        headline: "That's a pick slip",
        detail: `Order ${scanned}. Labels print from the Shipping page: scan it there.`,
        action: { label: "Open Shipping", run: () => router.push("/shipping") },
      });
      focusScan();
      return;
    }

    // A bin label says where you're standing: picks come off that bin first.
    if (kind === "bin") {
      setCurrentBin(scanned);
      show({ tone: "info", headline: `At bin ${scanned}`, detail: "Picks come off this bin's count first." });
      focusScan();
      return;
    }

    if (selected) {
      await submitPick(selected, scanned);
      return;
    }

    const matches = linesForScan(lines, scanned);
    if (matches.length > 0) {
      await submitPick(matches[0], scanned);
      return;
    }

    if (kind !== "item" && kind !== "upc") {
      show({ tone: "bad", headline: "Not an item label", detail: `${scanned} isn't an item code. Scan the ES label on the bag.` });
      focusScan();
      return;
    }

    // Nothing open needs it. Say what it is so it goes back where it lives.
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch(`/api/ship/lookup?code=${encodeURIComponent(scanned)}`);
      const json = (await res.json()) as { item: ScannedItem | null };
      const already = inApp.some((l) => l.item && normalizeCode(l.item.code) === scanned);
      show({
        tone: "bad",
        headline: already ? "Already picked" : "No order needs this",
        detail: json.item
          ? `That's ${describe(json.item)}. ${already ? "Every order that needs it is picked." : "Nothing open needs it."}`
          : `Nothing in the app has the code ${scanned}.`,
        note: json.item ? putBack(json.item.location) : null,
      });
    } catch {
      show({ tone: "bad", headline: "No order needs this", detail: `No open order needs ${scanned}.` });
    } finally {
      busyRef.current = false;
      setBusy(false);
      focusScan();
    }
  }

  async function undo(line: PickLine) {
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/ship/unpick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: line.orderId, channel: line.channel, lineItemId: line.lineItemId }),
      });
      const json = (await res.json()) as UnpickResponse | { error: string };
      if ("error" in json) throw new Error(json.error);
      if (!json.ok) {
        show({ tone: "bad", headline: "Can't undo", detail: json.reason });
        return;
      }
      updateLine(line.key, { picked: json.picked });
      show({
        tone: "info",
        headline: "Pick undone",
        detail: json.returnedToBin
          ? `Put it back in ${json.returnedToBin}.`
          : line.grabFrom.binningTable
            ? "Put it back on the binning table."
            : line.grabFrom.shelf
            ? `Put it back on shelf ${line.grabFrom.shelf}.`
            : "Put it back where it came from.",
      });
    } catch (e) {
      show({ tone: "bad", headline: "Can't undo", detail: e instanceof Error ? e.message : "Try again." });
    } finally {
      busyRef.current = false;
      setBusy(false);
      focusScan();
    }
  }

  function selectLine(l: PickLine) {
    setSelectedKey((k) => (k === l.key ? null : l.key));
    setResult(null);
    focusScan();
  }

  const scanPrompt = selected
    ? selected.verifyBy === "label"
      ? `Scan ${selected.item?.code}`
      : selected.verifyBy === "upc"
        ? "Scan the product's UPC"
        : "No barcode on record, tap Found it"
    : "Scan an item label";

  return (
    <AppShell
      title="Pick orders"
      subtitle="Scan each item's label. Green means put it with that order."
      width="narrow"
      actions={
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden />
          Refresh
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {loadError && <Alert tone="danger">{loadError}</Alert>}
        {data?.warnings.map((w) => (
          <Alert key={w} tone="warning">
            {w}
          </Alert>
        ))}
        {!data && !loadError && <p className="text-sm text-muted-foreground">Loading orders…</p>}

        {data && (
          <>
            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-medium text-foreground">
                  {unitsLeft} to pick, {unitsDone} done
                </span>
                <span className="text-muted-foreground">
                  {boxesReady} {boxesReady === 1 ? "box" : "boxes"} ready to pack
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-success transition-[width] duration-300"
                  style={{ width: `${unitsLeft + unitsDone ? (unitsDone / (unitsLeft + unitsDone)) * 100 : 0}%` }}
                />
              </div>
            </div>

            {result && <ResultPanel result={result} onUndo={undo} busy={busy} onClose={() => setResult(null)} />}

            <ScanField
              id={SCAN_ID}
              label={selected ? `Checking for order ${selected.orderNumber}` : "Item label"}
              prompt={scanPrompt}
              autoFocus
              value={code}
              onChange={setCode}
              onScan={() => handleScan(code)}
              hint={
                currentBin ? (
                  <span className="inline-flex items-center gap-1">
                    At {currentBin}.
                    <button type="button" className="font-medium text-primary underline" onClick={() => setCurrentBin(null)}>
                      Clear
                    </button>
                  </span>
                ) : (
                  "Scan an item label and it finds the order. Shipping labels print from the Shipping page."
                )
              }
            />

            {nextUp && <NextUpCard line={nextUp} selected={selected != null} onFound={() => submitPick(nextUp, "", true)} busy={busy} onClear={() => setSelectedKey(null)} />}

            {openLines.length === 0 && findYourself.length === 0 && (
              <Card>
                <p className="text-sm text-foreground">Nothing left to pick right now.</p>
              </Card>
            )}

            {openLines.length > 0 && (
              <section>
                <SectionHeader title={`To pick (${openLines.length})`} description="In walking order: shelf, then bin." />
                <ul className="flex flex-col gap-2">
                  {openLines.map((l) => (
                    <LineRow key={l.key} line={l} selected={l.key === selectedKey} onSelect={() => selectLine(l)} />
                  ))}
                </ul>
              </section>
            )}

            {packCards.length > 0 && (
              <section>
                <SectionHeader
                  title={`Ready to pack (${boxesReady})`}
                  description="One card per box. Pickups go to the hand-over spot, not the shipping pile."
                />
                <ul className="flex flex-col gap-2">
                  {packCards.map((card) => {
                    const first = card.orders[0];
                    const combined = card.orders.length > 1;
                    const holding = card.waitingOn.length > 0;
                    return (
                      <li key={card.key}>
                        <Card className={holding ? "border-amber-300 bg-amber-50/50" : "border-green-300 bg-green-50/50"}>
                          <p className="flex items-center gap-2 font-semibold text-foreground">
                            <PackageCheck className={cn("size-5", holding ? "text-amber-700" : "text-success")} aria-hidden />
                            {combined ? `Combine ${card.orders.length} orders${first.buyer ? ` · ${first.buyer}` : ""}` : orderLabel(first)}
                            {first.pickup && <Badge tone="primary">Pickup</Badge>}
                            {first.delivery && <Badge tone="primary">Local delivery</Badge>}
                            <Button
                              size="sm"
                              variant="outline"
                              className="ml-auto"
                              onClick={() => reprintSlip({ key: card.key, lines: first.lines })}
                              disabled={slipBusy === card.key}
                            >
                              {slipBusy === card.key ? "Sending…" : "Packing slip"}
                            </Button>
                          </p>
                          {combined && (
                            <p className="mt-1 text-sm text-foreground">
                              {holding
                                ? `Hold: order ${orderList(card.waitingOn)} isn't picked yet. Same buyer, same address, so it all goes in one box.`
                                : "Same buyer, same address: pack them in one box and buy one combined label in eBay."}
                            </p>
                          )}
                          {slipMessage?.key === card.key && <p className="mt-1 text-xs text-foreground">{slipMessage.text}</p>}
                          {first.lines[0]?.orderUrl && !first.delivery && !holding && (
                            <a
                              href={first.lines[0].orderUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
                            >
                              <ExternalLink className="size-4" aria-hidden />
                              {first.lines[0].channel === "ebay" ? "Open in eBay" : "Open in Shopify"}
                              {first.pickup ? "" : combined ? " to combine and buy the label" : " to buy the label"}
                            </a>
                          )}
                          {card.orders.map((o) => (
                            <div key={o.key} className="mt-2">
                              {combined && (
                                <p className="text-xs font-semibold text-muted-foreground">
                                  Order {o.orderNumber}
                                  {card.waitingOn.includes(o.orderNumber) ? " · not picked yet" : " · picked"}
                                </p>
                              )}
                              <ul className="flex flex-col gap-1 text-sm">
                                {o.lines.map((l) => (
                                  <li key={l.key} className="text-foreground">
                                    {l.item ? (
                                      <>
                                        {l.quantity > 1 ? `${l.quantity} × ` : ""}
                                        {short(l.item.title, 60)}
                                      </>
                                    ) : (
                                      <span className="text-amber-800">
                                        Also grab {l.quantity > 1 ? `${l.quantity} × ` : ""}
                                        {short(l.listing.title, 60)} (find it yourself)
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </Card>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {findYourself.length > 0 && (
              <section>
                <SectionHeader
                  title={`Find it yourself (${findYourself.length})`}
                  description="Not in the app, so these can't be checked by scanning. Match the title."
                />
                <ul className="flex flex-col gap-2">
                  {findYourself.map((l) => (
                    <li key={l.key}>
                      <Card padded={false} className="flex gap-3 border-amber-200 p-3">
                        <Thumb src={l.listing.image} />
                        <div className="min-w-0 flex-1 text-sm">
                          <p className="font-medium text-foreground">
                            {l.quantity > 1 && <span className="font-bold">{l.quantity} × </span>}
                            {l.listing.title}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {[l.listing.shelfHint ? `Shelf ${l.listing.shelfHint}` : null, l.listing.customLabel ? `Label ${l.listing.customLabel}` : null]
                              .filter(Boolean)
                              .join(" · ") || "No location on record"}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{orderLabel(l)}</p>
                          {l.handoff === "pickup" && (
                            <Badge tone="primary" className="mt-1.5">
                              Pickup: hand to the customer
                            </Badge>
                          )}
                          {l.handoff === "delivery" && (
                            <Badge tone="primary" className="mt-1.5">
                              Local delivery: no label
                            </Badge>
                          )}
                          {l.combineWith.length > 0 && (
                            <Badge tone="primary" className="mt-1.5">
                              Ships with order {orderList(l.combineWith)}: one box
                            </Badge>
                          )}
                        </div>
                      </Card>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {counterLines.length > 0 && (
              <section>
                <SectionHeader
                  title={`Sold at the counter (${counterLines.length})`}
                  description="Scan the label to clear it from the bins."
                />
                <ul className="flex flex-col gap-2">
                  {counterLines.map((l) => (
                    <LineRow key={l.key} line={l} selected={l.key === selectedKey} onSelect={() => selectLine(l)} />
                  ))}
                </ul>
              </section>
            )}

            {doneLines.length > 0 && (
              <Card padded={false}>
                <button
                  type="button"
                  onClick={() => {
                    setShowDone((v) => !v);
                    focusScan();
                  }}
                  className="flex w-full items-center justify-between gap-2 p-4 text-left text-sm font-medium text-foreground"
                >
                  Picked so far ({unitsDone})
                  <ChevronDown className={cn("size-4 transition-transform", showDone && "rotate-180")} aria-hidden />
                </button>
                {showDone && (
                  <ul className="divide-y divide-border border-t border-border text-sm">
                    {doneLines.map((l) => (
                      <li key={l.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-foreground">{l.item?.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {l.picked} of {l.quantity} · Order {l.orderNumber}
                            {l.pickedBy.length ? ` · ${l.pickedBy.join(", ")}` : ""}
                          </p>
                        </div>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => undo(l)}>
                          <Undo2 className="size-4" aria-hidden />
                          Undo
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {vaLines.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setShowVa((v) => !v);
                    focusScan();
                  }}
                  className="text-xs font-medium text-muted-foreground underline"
                >
                  {showVa ? "Hide" : "Show"} old VA orders ({vaLines.length})
                </button>
                {showVa && (
                  <ul className="mt-2 divide-y divide-border rounded-xl border border-border text-sm">
                    {vaLines.map((l) => (
                      <li key={l.key} className="px-4 py-2.5">
                        <p className="text-foreground">
                          {l.quantity > 1 ? `${l.quantity} × ` : ""}
                          {l.listing.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {orderLabel(l)} · {l.listing.customLabel}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <p className="text-center text-xs text-muted-foreground">
              Updated {new Date(data.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Refreshes every minute.
              {data.shopify === "off" ? " Shopify orders aren't connected here." : ""}
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}

function Thumb({ src, size = "size-14" }: { src: string | null | undefined; size?: string }) {
  if (!src) return <div className={cn(size, "shrink-0 rounded-lg border border-border bg-muted")} aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={cn(size, "shrink-0 rounded-lg border border-border object-cover")} />;
}

// An old-system item has no label, so scanning can't tell a 3-pack from a
// single of the same product: the pack is shown big for the picker to check
// by eye. Labelled items carry it in the small facts line.
function ItemFacts({ line }: { line: PickLine }) {
  const item = line.item;
  if (!item) return null;
  const oldSystem = line.status === "in_app_legacy";
  const facts = [
    line.verifyBy === "label" ? item.code : null,
    item.expiration ? `exp ${item.expiration}` : null,
    item.condition,
    oldSystem ? null : item.pack,
  ].filter(Boolean);
  return (
    <>
      {oldSystem && <p className="mt-1 text-base font-bold text-amber-800">{item.pack}</p>}
      {facts.length > 0 && <p className="mt-0.5 text-xs text-muted-foreground">{facts.join(" · ")}</p>}
    </>
  );
}

// How this line gets checked, when it isn't the normal label scan.
function VerifyBadges({ line }: { line: PickLine }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {line.source !== "eBay" && <Badge tone="purple">{line.source}</Badge>}
      {line.handoff === "pickup" && <Badge tone="primary">Pickup: hand to the customer</Badge>}
      {line.handoff === "delivery" && <Badge tone="primary">Local delivery: no label</Badge>}
      {line.handoff === "counter" && <Badge tone="neutral">Sold at the counter</Badge>}
      {line.status === "in_app_legacy" && <Badge tone="warning">Old system</Badge>}
      {line.verifyBy === "upc" && <Badge tone="warning">No label, scan the UPC</Badge>}
      {line.verifyBy === "tap" && <Badge tone="warning">No barcode on record</Badge>}
      {line.cancelRequested && <Badge tone="danger">Buyer asked to cancel</Badge>}
      {line.combineWith.length > 0 && <Badge tone="primary">Ships with order {orderList(line.combineWith)}</Badge>}
    </div>
  );
}

function NextUpCard({
  line,
  selected,
  onFound,
  onClear,
  busy,
}: {
  line: PickLine;
  selected: boolean;
  onFound: () => void;
  onClear: () => void;
  busy: boolean;
}) {
  return (
    <Card className={cn("border-2", selected ? "border-primary" : "border-border")}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {selected ? "Checking this one" : "Next to grab"}
        </p>
        {selected && (
          <button type="button" onClick={onClear} className="inline-flex items-center gap-1 text-xs font-medium text-primary">
            <X className="size-3.5" aria-hidden />
            Any order
          </button>
        )}
      </div>
      <p className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
        <MapPin className="size-6 shrink-0 text-primary" aria-hidden />
        {placeText(line)}
      </p>
      <div className="mt-3 flex gap-3">
        <Thumb src={line.item?.photo} size="size-20" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-foreground">{line.item?.title}</p>
          <ItemFacts line={line} />
          <p className="mt-0.5 text-xs text-muted-foreground">
            {line.picked} of {line.quantity} · {orderLabel(line)}
          </p>
          <VerifyBadges line={line} />
        </div>
      </div>
      {line.location && line.location.bins.length > 1 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Also in: {line.location.bins.slice(1).map((b) => (b.shelfLabel ? `${b.binCode} (shelf ${b.shelfLabel})` : b.binCode)).join(", ")}
        </p>
      )}
      {/* Old-system items only: a worn or missing UPC shouldn't stop the
          pick. ES-labelled items always need their label scanned. */}
      {line.verifyBy === "tap" && (
        <Button variant="success" size="xl" block className="mt-3" disabled={busy} onClick={onFound}>
          <CircleCheck className="size-5" aria-hidden />
          Found it
        </Button>
      )}
      {line.verifyBy === "upc" && (
        <Button variant="outline" size="lg" block className="mt-3" disabled={busy} onClick={onFound}>
          <CircleCheck className="size-5" aria-hidden />
          {"Can't scan it? Found it"}
        </Button>
      )}
    </Card>
  );
}

function LineRow({ line, selected, onSelect }: { line: PickLine; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          "flex w-full gap-3 rounded-xl border bg-surface p-3 text-left shadow-sm transition-colors",
          selected ? "border-primary ring-2 ring-primary/25" : "border-border hover:bg-muted"
        )}
      >
        <Thumb src={line.item?.photo} />
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold text-foreground">{placeText(line)}</p>
          <p className="line-clamp-2 text-sm text-foreground">{line.item?.title}</p>
          <ItemFacts line={line} />
          <p className="mt-0.5 text-xs text-muted-foreground">{orderLabel(line)}</p>
          <VerifyBadges line={line} />
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-bold text-foreground">
            {line.picked}/{line.quantity}
          </p>
        </div>
      </button>
    </li>
  );
}

function ResultPanel({
  result,
  onUndo,
  onClose,
  busy,
}: {
  result: Result;
  onUndo: (line: PickLine) => void;
  onClose: () => void;
  busy: boolean;
}) {
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
          className="mt-3 mr-2 inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-sm font-medium hover:bg-white/25 disabled:opacity-50"
        >
          {result.action.label}
        </button>
      )}
      {result.undoLine && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onUndo(result.undoLine!)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-sm font-medium hover:bg-white/25 disabled:opacity-50"
        >
          <Undo2 className="size-4" aria-hidden />
          Undo this pick
        </button>
      )}
    </div>
  );
}
