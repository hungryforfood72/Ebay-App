"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import { Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  BannerPanel,
  beep,
  binCounts,
  errorText,
  focusField,
  ItemLine,
  plural,
  ScanStep,
  type Banner,
  type BinDetail,
  type BinSummary,
  type ItemRow,
} from "./ui";

const FIELD = "fill-scan";

type Waiting = { items: { item: ItemRow; loose: number; manifest: string | null }[]; count: number; looseUnits: number };
type FillResult = BinDetail & { item: ItemRow; reopened: boolean };

// The binning station. Listers label and bag every unit and move on; here
// someone opens an empty bin (scans it), scans each bag's label into it
// (one scan = one unit), and taps Close bin when it's full. Closed bins
// wait for the Shelve tab. Works across every load at once: the label
// says which item it is, so there's no manifest to pick.
export function FillPanel({ onWaitingCount }: { onWaitingCount: (count: number) => void }) {
  const [open, setOpen] = useState<BinDetail | null>(null);
  // A different bin scanned while one is open: asks before switching, so
  // a stray scan of a nearby bin label can't send the next bags into the
  // wrong bin.
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  // This visit's scans into the open bin, newest last, for Undo.
  const [history, setHistory] = useState<{ itemId: string; code: string; title: string }[]>([]);
  const [lastItemId, setLastItemId] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [busy, setBusy] = useState(false);

  // Scans are handled one at a time, in order, without dropping any: a
  // fast run of bag scans queues up instead of racing each other.
  const queue = useRef<Promise<void>>(Promise.resolve());
  // The latest open bin / pending switch for queued scans (state inside a
  // queued callback would be the value from when it was queued).
  // Each is written together with its state (see show / keepHistory /
  // keepWaiting) so the next queued scan sees it right away.
  const openRef = useRef<BinDetail | null>(null);
  const pendingRef = useRef<string | null>(null);
  const historyRef = useRef<{ itemId: string; code: string; title: string }[]>([]);
  const waitingRef = useRef<Waiting | null>(null);

  const loadWaiting = useCallback(() => {
    fetch("/api/bins/fill")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Waiting | null) => {
        if (!d) return;
        waitingRef.current = d;
        setWaiting(d);
        onWaitingCount(d.count);
      })
      .catch(() => {
        // Tried again on the next refresh.
      });
  }, [onWaitingCount]);

  // Listers keep labeling while this is open, so the list refreshes itself.
  useEffect(() => {
    loadWaiting();
    const t = setInterval(loadWaiting, 30_000);
    return () => clearInterval(t);
  }, [loadWaiting]);

  function show(next: BinDetail | null) {
    openRef.current = next;
    setOpen(next);
  }

  function keepHistory(next: { itemId: string; code: string; title: string }[]) {
    historyRef.current = next;
    setHistory(next);
  }

  function fail(title: string, line?: string) {
    beep("error");
    setBanner({ tone: "danger", title, lines: line ? [line] : [] });
  }

  async function openBin(code: string) {
    try {
      const res = await api<BinDetail & { wasClosed: boolean }>("/api/bins/fill/open", { binCode: code });
      show(res);
      keepHistory([]);
      setLastItemId(null);
      beep("next");
      setBanner({
        tone: "info",
        title: `${res.bin.code} open`,
        lines: [
          res.wasClosed
            ? "This bin was closed. Adding anyway."
            : res.contents.length > 0
              ? `Already has ${binCounts(res.bin).toLowerCase()}. Keep adding.`
              : "Scan each bag's label into it.",
        ],
      });
    } catch (e) {
      fail("Can't use that bin", errorText(e));
    }
  }

  async function closeBin(current: BinDetail): Promise<boolean> {
    try {
      const res = await api<{ bin: BinSummary }>("/api/bins/fill/close", { binCode: current.bin.code });
      show(null);
      keepHistory([]);
      setLastItemId(null);
      beep("ok");
      setBanner({
        tone: "success",
        title: res.bin.status === "empty" ? `${res.bin.code} is empty` : `${res.bin.code} closed`,
        lines: [
          res.bin.status === "empty" ? "Nothing in it, so it's still free to use." : `${binCounts(res.bin)}. Set it with the bins ready to shelve.`,
          "Scan the next empty bin.",
        ],
      });
      loadWaiting();
      return true;
    } catch (e) {
      fail("Not closed", errorText(e));
      return false;
    }
  }

  async function addItem(current: BinDetail, code: string) {
    try {
      const res = await api<FillResult>("/api/bins/fill", { binCode: current.bin.code, itemCode: code });
      show(res);
      keepHistory([...historyRef.current, { itemId: res.item.id, code: res.item.code, title: res.item.title }]);
      setLastItemId(res.item.id);
      // One less loose unit of it on the waiting list.
      const w = waitingRef.current;
      const before = w?.items.find((x) => x.item.id === res.item.id)?.loose ?? 0;
      const stillLoose = Math.max(0, before - 1);
      if (w && before > 0) {
        const items = w.items
          .map((x) => (x.item.id === res.item.id ? { ...x, loose: x.loose - 1 } : x))
          .filter((x) => x.loose > 0);
        const next = { items, count: w.count - (w.items.length - items.length), looseUnits: Math.max(0, w.looseUnits - 1) };
        waitingRef.current = next;
        setWaiting(next);
        onWaitingCount(next.count);
      }
      const inThisBin = res.contents.find((c) => c.id === res.item.id)?.units ?? 1;
      beep("ok");
      setBanner({
        tone: "success",
        title: `+1 ${res.item.code}`,
        lines: [
          res.item.title,
          `${plural(inThisBin, "unit")} of this in ${res.bin.code}${stillLoose > 0 ? `, ${stillLoose} more still loose` : ""}.`,
          res.reopened ? "This bin was closed. Adding anyway." : "",
        ],
      });
    } catch (e) {
      fail("Not added", errorText(e));
    }
  }

  async function handle(raw: string) {
    const code = normalizeCode(raw);
    const kind = classifyScan(code);
    const current = openRef.current;
    const pending = pendingRef.current;

    if (kind === "bin") {
      if (!current) return openBin(code);
      if (code === current.bin.code) {
        setPendingSwitch(null);
        pendingRef.current = null;
        beep("next");
        setBanner({ tone: "info", title: `${code} is already open`, lines: ["Keep scanning bags into it."] });
        return;
      }
      // Same other bin scanned twice = yes, switch.
      if (pending === code) return switchTo(code);
      setPendingSwitch(code);
      pendingRef.current = code;
      beep("next");
      setBanner(null);
      return;
    }
    if (kind !== "item") {
      return fail(
        kind === "upc" ? "That's the product barcode" : "Not an item label",
        "Scan the label on the bag (starts with ES), or a bin label."
      );
    }
    if (pending) return fail("Choose first", `Close ${current?.bin.code} and switch, or keep filling it.`);
    if (!current) return fail("Open a bin first", "Scan an empty bin's label, then the bags.");
    return addItem(current, code);
  }

  async function switchTo(code: string) {
    const current = openRef.current;
    setPendingSwitch(null);
    pendingRef.current = null;
    if (current && !(await closeBin(current))) return;
    await openBin(code);
  }

  // Everything (scans and buttons) goes through the queue so nothing runs
  // out of order.
  function enqueue(task: () => Promise<void>) {
    queue.current = queue.current.then(async () => {
      setBusy(true);
      try {
        await task();
      } finally {
        setBusy(false);
        focusField(FIELD);
      }
    });
  }

  async function undo() {
    const current = openRef.current;
    const last = historyRef.current[historyRef.current.length - 1];
    if (!current || !last) return;
    try {
      const res = await api<BinDetail>("/api/bins/fill/undo", { binCode: current.bin.code, itemId: last.itemId });
      show(res);
      keepHistory(historyRef.current.slice(0, -1));
      setLastItemId(null);
      loadWaiting();
      beep("next");
      setBanner({ tone: "info", title: `Took 1 ${last.code} back out`, lines: [last.title] });
    } catch (e) {
      fail("Couldn't undo", errorText(e));
    }
  }

  const loose = waiting?.looseUnits ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Filling</p>
          <p className="font-mono text-3xl font-bold tracking-tight text-foreground">{open ? open.bin.code : "No bin open"}</p>
          {open && <p className="mt-1 text-sm text-muted-foreground">{binCounts(open.bin)}</p>}
        </div>
        {open && (
          <Button size="lg" variant="success" onClick={() =>
              enqueue(async () => {
                const current = openRef.current;
                if (current) await closeBin(current);
              })
            } disabled={busy}>
            Close bin
          </Button>
        )}
      </div>

      <ScanStep
        id={FIELD}
        label={open ? "Bag label" : "Bin"}
        prompt={open ? `Scan each bag into ${open.bin.code}` : "Scan an empty bin to fill"}
        hint={open ? "One scan = one unit. Tap Close bin when it's full." : "Then scan each bag's label into it."}
        onScan={(code) => enqueue(() => handle(code))}
      />

      {pendingSwitch && open && (
        <Card className="border-amber-300 bg-amber-50">
          <p className="text-base font-semibold text-amber-950">
            {open.bin.code} is still open. Close it and start {pendingSwitch}?
          </p>
          <p className="mt-1 text-sm text-amber-900">Scanning {pendingSwitch} again also switches.</p>
          <div className="mt-3 flex flex-col gap-2">
            <Button size="lg" block onClick={() => enqueue(() => switchTo(pendingSwitch))}>
              Close {open.bin.code}, start {pendingSwitch}
            </Button>
            <Button
              variant="outline"
              size="lg"
              block
              onClick={() => {
                setPendingSwitch(null);
                pendingRef.current = null;
                focusField(FIELD);
              }}
            >
              Keep filling {open.bin.code}
            </Button>
          </div>
        </Card>
      )}

      {banner && <BannerPanel banner={banner} />}

      {open && (
        <Card padded={false}>
          <SectionHeader
            title={`In ${open.bin.code} (${plural(open.bin.units, "unit")})`}
            action={
              history.length > 0 ? (
                <Button variant="outline" size="sm" onClick={() => enqueue(undo)} disabled={busy}>
                  <Undo2 className="size-4" aria-hidden />
                  Undo last scan
                </Button>
              ) : undefined
            }
            className="mb-0 p-4 pb-3"
          />
          {open.contents.length === 0 ? (
            <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">Empty so far.</p>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {[...open.contents]
                .sort((a, b) => Number(b.id === lastItemId) - Number(a.id === lastItemId))
                .map((c) => (
                  <li key={c.id} className={cn("px-4 py-3", c.id === lastItemId && "bg-green-50")}>
                    <ItemLine item={c} right={<span className="text-lg font-semibold text-foreground">×{c.units}</span>} />
                  </li>
                ))}
            </ul>
          )}
        </Card>
      )}

      <Card padded={false}>
        <SectionHeader
          title="Waiting to be binned"
          description={
            waiting
              ? waiting.count === 0
                ? "Nothing loose. Every labeled unit is in a bin."
                : `${plural(loose, "unit")} across ${plural(waiting.count, "listing")}, oldest first.`
              : "Loading…"
          }
          action={waiting && waiting.count > 0 ? <Badge tone="warning">{waiting.count}</Badge> : undefined}
          className="mb-0 p-4 pb-3"
        />
        {waiting && waiting.items.length > 0 && (
          <ul className="divide-y divide-border border-t border-border">
            {waiting.items.map((w) => (
              <li key={w.item.id} className="px-4 py-3">
                <ItemLine
                  item={w.item}
                  sub={w.manifest ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{w.manifest}</p> : undefined}
                  right={
                    <span className="text-sm font-semibold text-foreground">
                      {w.loose}
                      <span className="block text-xs font-normal text-muted-foreground">loose</span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {waiting && waiting.count > waiting.items.length && (
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            Showing the oldest {waiting.items.length} of {waiting.count}.
          </p>
        )}
      </Card>
    </div>
  );
}
