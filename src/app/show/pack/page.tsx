"use client";

import { beep, focusField } from "@/app/bins/ui";
import { ScanField } from "@/components/ScanField";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import { classifyScan } from "@/lib/warehouse/codes";
import type { StationStatus } from "@/lib/warehouse/types";
import type { LabelStatus, PackListRow, PackScanResult, PackView } from "@/lib/whatnotPack";
import { CheckCircle2, LoaderCircle, Printer } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// Packing mode for a Whatnot show (Cristian, 2026-11-07), at the Whatnot
// station after the show: scan a show box's QR, scan every item into the
// shipping box (a wrong one, a missing one or a cancelled one is caught),
// then Print label: Whatnot makes it and it prints here. Seal the box; the
// show box is free for the next show.

type ShowRow = { showId: string; title: string | null; buyers: number; toPack: number; lastSale: string };
const STATION_KEY = "ebay-tool.packStationId";
const LABEL_POLL_MS = 3_000;

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/show/pack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? "Something went wrong. Try again.");
  return data as T;
}

function saved(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export default function PackPage() {
  const [shows, setShows] = useState<ShowRow[] | null>(null);
  const [showId, setShowId] = useState("");
  const [list, setList] = useState<PackListRow[] | null>(null);
  const [view, setView] = useState<PackView | null>(null);
  const [scan, setScan] = useState("");
  const [binScan, setBinScan] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: "success" | "danger" | "warning" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState<LabelStatus | null>(null);
  const [stations, setStations] = useState<StationStatus[] | null>(null);
  const [stationId, setStationIdState] = useState("");

  // Shows, and where labels print: this PC's station (or the one you're
  // signed in at), else the last one picked here.
  useEffect(() => {
    fetch("/api/show/pack", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { shows?: ShowRow[] }) => {
        setShows(d.shows ?? []);
        if (d.shows?.[0]) setShowId(d.shows[0].showId);
      })
      .catch(() => setShows([]));
    Promise.all([
      fetch("/api/stations", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])),
      fetch("/api/stations/mine", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([all, mine]: [StationStatus[] | { stations?: StationStatus[] }, { stationId: string | null } | null]) => {
      const listed = Array.isArray(all) ? all : (all.stations ?? []);
      setStations(listed);
      const pick = [mine?.stationId, saved(STATION_KEY), listed.find((s) => s.printerName)?.id].find((id) => id && listed.some((s) => s.id === id));
      if (pick) setStationIdState(pick);
    });
  }, []);

  function setStationId(id: string) {
    setStationIdState(id);
    try {
      localStorage.setItem(STATION_KEY, id);
    } catch {
      // Remembered for this visit only.
    }
  }

  const loadList = useCallback(async () => {
    if (!showId) return;
    const r = await fetch(`/api/show/pack?showId=${encodeURIComponent(showId)}`, { cache: "no-store" });
    const d = await r.json().catch(() => null);
    if (r.ok) setList(d.list);
  }, [showId]);

  useEffect(() => {
    if (!showId) return;
    let cancelled = false;
    fetch(`/api/show/pack?showId=${encodeURIComponent(showId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { list?: PackListRow[] } | null) => {
        if (!cancelled && d?.list) setList(d.list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showId]);

  const openBuyer = useCallback(async (buyerId: string) => {
    const r = await fetch(`/api/show/pack?buyerId=${encodeURIComponent(buyerId)}&fresh=1`, { cache: "no-store" });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(d?.error ?? "Couldn't open that order.");
    setView(d);
    setLabel(null);
    setNotice(null);
  }, []);

  async function refreshView() {
    if (!view) return;
    const r = await fetch(`/api/show/pack?buyerId=${encodeURIComponent(view.buyerId)}`, { cache: "no-store" });
    if (r.ok) setView(await r.json());
  }

  async function onScan() {
    const code = scan.trim();
    setScan("");
    if (!code) return;
    setBusy(true);
    setNotice(null);
    try {
      if (classifyScan(code) === "showbox" || !view) {
        const v = await call<PackView>({ action: "open", code });
        setView(v);
        setLabel(null);
        beep("next");
      } else {
        const r = await call<PackScanResult>({ action: "scan", buyerId: view.buyerId, code });
        if (r.ok) {
          beep(r.complete ? "ok" : "next");
          setNotice({ tone: "success", text: `${r.title}: ${r.packed} of ${r.quantity} in.${r.complete ? " Everything's in. Print the label." : ""}` });
        } else {
          beep("error");
          setNotice({ tone: "danger", text: r.reason });
        }
        await refreshView();
      }
    } catch (e) {
      beep("error");
      setNotice({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(false);
      focusField("pack-scan");
    }
  }

  async function act(body: Record<string, unknown>, done?: string) {
    setBusy(true);
    setNotice(null);
    try {
      await call(body);
      if (done) setNotice({ tone: "success", text: done });
      await refreshView();
      await loadList();
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
      beep("error");
    } finally {
      setBusy(false);
    }
  }

  async function printLabel() {
    if (!view || !stationId) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await call<LabelStatus>({ action: "label", buyerId: view.buyerId, stationId });
      setLabel(r);
      if (r.status === "printed") beep("ok");
      if (r.status === "error") beep("error");
      await refreshView();
    } catch (e) {
      setLabel({ status: "error", message: (e as Error).message });
      beep("error");
    } finally {
      setBusy(false);
    }
  }

  // Waiting for Whatnot to make the label: check every few seconds.
  useEffect(() => {
    if (!view || label?.status !== "waiting") return;
    const timer = setTimeout(async () => {
      try {
        const r = await call<LabelStatus>({ action: "label_check", buyerId: view.buyerId });
        setLabel(r);
        if (r.status === "printed") {
          beep("ok");
          await refreshView();
          await loadList();
        }
      } catch (e) {
        setLabel({ status: "error", message: (e as Error).message });
      }
    }, LABEL_POLL_MS);
    return () => clearTimeout(timer);
    // refreshView/loadList read the latest view; the timer only needs the label state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, view?.buyerId]);

  const live = view?.lines.filter((l) => !l.cancelled) ?? [];
  const units = live.reduce((n, l) => n + l.quantity, 0);
  const packed = live.reduce((n, l) => n + l.packed, 0);
  const station = stations?.find((s) => s.id === stationId) ?? null;

  return (
    <AppShell
      width="narrow"
      title="Pack Whatnot orders"
      subtitle="Scan a show box, scan every item into the shipping box, print the label."
      actions={
        <Link href="/show" className={buttonClasses({ variant: "outline", size: "sm" })}>
          Show screen
        </Link>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={showId} onChange={(e) => setShowId(e.target.value)} aria-label="Show">
            {(shows ?? []).length === 0 && <option value="">No shows with sales yet</option>}
            {(shows ?? []).map((s) => (
              <option key={s.showId} value={s.showId}>
                {s.title ?? "A show"} · {s.toPack} to pack
              </option>
            ))}
          </Select>
          <Select value={stationId} onChange={(e) => setStationId(e.target.value)} aria-label="Labels print at">
            <option value="">Labels print at…</option>
            {(stations ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                Labels print at {s.name}
                {s.printerName ? "" : " (no 4x6 printer)"}
              </option>
            ))}
          </Select>
        </div>

        <Card>
          <ScanField
            id="pack-scan"
            label={view ? "Scan each item" : "Scan a show box"}
            prompt={view ? "Scan the ES label on each item as it goes in" : "Scan the QR on a WHATNOT SHOW BOX"}
            autoFocus
            value={scan}
            onChange={setScan}
            onScan={onScan}
            hint={busy ? "Checking…" : view ? "Scanning another show box opens that one." : undefined}
          />
        </Card>
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

        {view && (
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-3xl font-black tabular-nums">
                  {view.boxes.length ? `Box ${view.boxes.join(" + ")}` : "Packed"}
                </p>
                <p className="text-lg font-semibold">{view.buyer}</p>
                {view.boxes.length > 1 && <p className="text-sm font-medium text-amber-700">Bring all {view.boxes.length} show boxes.</p>}
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold tabular-nums">
                  {packed}/{units}
                </p>
                <p className="text-xs text-muted-foreground">in the box</p>
              </div>
            </div>
            {view.warnings.map((w) => (
              <Alert key={w} tone="warning" className="mt-3">
                {w}
              </Alert>
            ))}
            {view.shipments.some((s) => s.pickup) && (
              <Alert tone="info" className="mt-3">
                Local pickup: no shipping label. Bag it with the buyer&apos;s name.
              </Alert>
            )}

            <ul className="mt-3 divide-y divide-border">
              {view.lines.map((l) => (
                <li key={l.orderItemId} className={`flex items-center gap-3 py-2.5 ${l.cancelled && !l.putBack ? "opacity-50" : ""}`}>
                  {l.photo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.photo} alt="" className="size-12 shrink-0 rounded-md object-cover" />
                  ) : (
                    <span className="size-12 shrink-0 rounded-md bg-muted" />
                  )}
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="line-clamp-2 font-medium">{l.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {l.code && <span className="font-mono">{l.code}</span>}
                      {l.saleType === "giveaway" ? " · giveaway" : ""}
                      {l.source === "shelf" ? " · from the shop, not the show" : ""}
                    </p>
                    {!l.cancelled && l.where && l.packed < l.quantity && (
                      <p className="text-xs font-medium text-amber-700">Not in the show box: grab it from {l.where}</p>
                    )}
                    {l.putBack && (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-danger">Cancelled: take it out. Scan the bin it goes back in.</span>
                        <input
                          className="w-28 rounded border border-border px-2 py-1 text-xs"
                          placeholder={l.fromBin ?? "Bin"}
                          value={binScan[l.orderItemId] ?? ""}
                          onChange={(e) => setBinScan({ ...binScan, [l.orderItemId]: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && l.saleId && !busy) {
                              void act(
                                { action: "put_back", buyerId: view.buyerId, saleId: l.saleId, binCode: (binScan[l.orderItemId] || l.fromBin || "").trim() },
                                "Back in its bin."
                              );
                            }
                          }}
                          aria-label="Bin it goes back in"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !(binScan[l.orderItemId] || l.fromBin)}
                          onClick={() =>
                            l.saleId &&
                            act(
                              { action: "put_back", buyerId: view.buyerId, saleId: l.saleId, binCode: (binScan[l.orderItemId] || l.fromBin || "").trim() },
                              "Back in its bin."
                            )
                          }
                        >
                          Put back
                        </Button>
                      </div>
                    )}
                    {l.cancelled && !l.putBack && <p className="text-xs">Cancelled: don&apos;t pack it.</p>}
                  </div>
                  {!l.cancelled &&
                    (l.packed >= l.quantity ? (
                      <CheckCircle2 className="size-6 shrink-0 text-success" aria-label="In the box" />
                    ) : l.unknown ? (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "by_hand", buyerId: view.buyerId, orderItemId: l.orderItemId })}>
                        It&apos;s in
                      </Button>
                    ) : (
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {l.packed}/{l.quantity}
                      </span>
                    ))}
                </li>
              ))}
            </ul>

            <div className="mt-3 flex flex-col gap-2">
              {view.packedAt ? (
                <>
                  <Alert tone="success">Packed. The show box is free.</Alert>
                  {view.labelCount > 0 && (
                    <Button variant="outline" size="sm" disabled={busy || !stationId} onClick={() => act({ action: "reprint", buyerId: view.buyerId, stationId }, "Sent to the printer again.")}>
                      <Printer className="size-4" aria-hidden />
                      Reprint the label
                    </Button>
                  )}
                </>
              ) : view.nothingToShip ? (
                <Button variant="outline" disabled={busy} onClick={() => act({ action: "close_empty", buyerId: view.buyerId }, "Nothing to ship. The show box is free.")}>
                  Nothing to ship: free the box
                </Button>
              ) : (
                <Button size="lg" disabled={busy || !view.complete || !stationId || label?.status === "waiting"} onClick={printLabel}>
                  <Printer className="size-5" aria-hidden />
                  {view.complete ? (view.shipments.every((s) => s.pickup) ? "Done (pickup)" : "Print label") : `Scan ${units - packed} more`}
                </Button>
              )}
              {!stationId && !view.packedAt && <p className="text-sm text-danger">Pick where labels print (top of the page).</p>}
              {station && !station.printerName && <p className="text-sm text-danger">{station.name} has no 4x6 printer picked. Set it on its station page.</p>}
              {label && (
                <Alert tone={label.status === "printed" ? "success" : label.status === "error" ? "danger" : "info"}>
                  {label.status === "waiting" && <LoaderCircle className="mr-1 inline size-4 animate-spin" aria-hidden />}
                  {label.message}
                </Alert>
              )}
              {(view.packedAt || label?.status === "printed") && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setView(null);
                    setLabel(null);
                    setNotice(null);
                    void loadList();
                    focusField("pack-scan");
                  }}
                >
                  Next box
                </Button>
              )}
            </div>
          </Card>
        )}

        {!view && list && (
          <Card padded={false}>
            {list.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No buyers in this show.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {list.map((b) => (
                  <li key={b.buyerId}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted"
                      onClick={() => openBuyer(b.buyerId).catch((e) => setNotice({ tone: "danger", text: (e as Error).message }))}
                    >
                      <span className="w-16 shrink-0 text-xl font-black tabular-nums">{b.boxes.length ? b.boxes.join("+") : "-"}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{b.buyer}</span>
                        <span className="block text-xs text-muted-foreground">
                          {b.units} item{b.units === 1 ? "" : "s"}
                          {b.unsorted > 0 ? ` · ${b.unsorted} still in a bin` : ""}
                          {b.cancelled > 0 ? ` · ${b.cancelled} cancelled` : ""}
                        </span>
                      </span>
                      {b.status === "packed" ? (
                        <Badge tone="success">Packed</Badge>
                      ) : b.status === "label" ? (
                        <Badge tone="warning">Label asked for</Badge>
                      ) : (
                        <Badge>To pack</Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </AppShell>
  );
}
