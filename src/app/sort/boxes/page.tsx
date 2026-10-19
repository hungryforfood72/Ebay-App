"use client";

import { StationPicker, useChosenStation } from "@/components/StationPicker";
import { useCurrentUser } from "@/components/UserNav";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { LoaderCircle, Printer } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// Sort boxes (SB0001...): the reusable boxes good units go in at the sort
// station. The owner makes them and prints their labels in a range; anyone
// can reprint one torn label. A box is free again once everything in it has
// been pulled to listing, even while it still shows its last load.

// GET /api/sort-boxes
type SortBoxRow = {
  code: string;
  manifestId: string | null;
  manifestTitle: string | null;
  unitsLeft: number;
  unitsSorted: number;
  free: boolean;
};

type Message = { tone: "success" | "danger"; text: string };

async function send(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "That didn't work. Try again.");
  return data;
}

export default function SortBoxesPage() {
  const user = useCurrentUser();
  const isOwner = user?.role === "owner";
  const stations = useChosenStation(true);
  const [boxes, setBoxes] = useState<SortBoxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState("20");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // A print waiting for this device to pick its station.
  const [pendingPrint, setPendingPrint] = useState<((stationId: string) => void) | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/sort-boxes")
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error ?? "Couldn't load the sort boxes.");
          return d.boxes as SortBoxRow[];
        })
        .then((list) => {
          setBoxes(list);
          setError(null);
        }),
    []
  );

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Couldn't load the sort boxes."));
  }, [load]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: "success", text: await action() });
      await load().catch(() => {});
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "That didn't work. Try again." });
    } finally {
      setBusy(false);
    }
  }

  // Runs a print at this device's station, asking for one first if needed.
  function withStation(print: (stationId: string) => void) {
    if (stations.station) print(stations.station.id);
    else setPendingPrint(() => print);
  }

  function makeBoxes() {
    void run(async () => {
      const d = await send("/api/sort-boxes", { count: Number(count) });
      const codes = d.codes as string[];
      setFrom(codes[0]);
      setTo(codes[codes.length - 1]);
      return `Made ${codes.length} boxes: ${codes[0]} to ${codes[codes.length - 1]}. Print their labels below.`;
    });
  }

  function printRange() {
    withStation((stationId) =>
      run(async () => {
        const d = await send("/api/sort-boxes/print", { from, to: to || from, stationId });
        const printed = d.printed as string[];
        return `Printing ${printed.length} ${printed.length === 1 ? "label" : "labels"} at ${stationName(stationId)}.`;
      })
    );
  }

  function reprint(code: string) {
    withStation((stationId) =>
      run(async () => {
        await send(`/api/sort-boxes/${encodeURIComponent(code)}/print`, { stationId });
        return `Label for ${code} is printing at ${stationName(stationId)}.`;
      })
    );
  }

  function stationName(id: string) {
    return stations.stations?.find((s) => s.id === id)?.name ?? "the station";
  }

  const freeCount = boxes?.filter((b) => b.free).length ?? 0;

  return (
    <AppShell
      width="medium"
      title="Sort boxes"
      subtitle="Reusable boxes for good units at the sort station."
      actions={
        <Link href="/sort" className={buttonClasses({ variant: "outline", size: "sm" })}>
          Back to sorting
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        {pendingPrint && (
          <StationPicker
            stations={stations.stations}
            selectedId={stations.station?.id ?? null}
            error={stations.error}
            onPick={(s) => {
              stations.choose(s.id);
              const print = pendingPrint;
              setPendingPrint(null);
              print(s.id);
            }}
            onCancel={() => setPendingPrint(null)}
            onReload={stations.reload}
          />
        )}

        {message && <Alert tone={message.tone}>{message.text}</Alert>}

        {isOwner && (
          <Card>
            <SectionHeader title="Make and print boxes" description="Labels print at this device's station." />
            <div className="flex flex-col gap-4">
              <div className="flex items-end gap-2">
                <label className="flex-1 text-sm font-medium text-foreground">
                  How many new boxes
                  <Input
                    className="mt-1"
                    type="number"
                    min={1}
                    max={500}
                    inputMode="numeric"
                    value={count}
                    onChange={(e) => setCount(e.target.value)}
                  />
                </label>
                <Button onClick={makeBoxes} disabled={busy}>
                  Make boxes
                </Button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-24 flex-1 text-sm font-medium text-foreground">
                  From
                  <Input className="mt-1" placeholder="SB0001" value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label className="min-w-24 flex-1 text-sm font-medium text-foreground">
                  To
                  <Input className="mt-1" placeholder="SB0020" value={to} onChange={(e) => setTo(e.target.value)} />
                </label>
                <Button variant="outline" onClick={printRange} disabled={busy || !from.trim()}>
                  <Printer className="size-4" aria-hidden />
                  Print labels
                </Button>
              </div>
              {stations.station && (
                <p className="text-xs text-muted-foreground">
                  Printing at {stations.station.name}.{" "}
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    // Opens the picker; picking just changes the station.
                    onClick={() => setPendingPrint(() => () => {})}
                  >
                    Change
                  </button>
                </p>
              )}
            </div>
          </Card>
        )}

        <section>
          <SectionHeader
            title="All sort boxes"
            action={boxes ? <Badge>{`${freeCount} free of ${boxes.length}`}</Badge> : undefined}
          />
          {error && <Alert tone="danger">{error}</Alert>}
          {!error && boxes === null && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Loading…
            </p>
          )}
          {boxes && boxes.length === 0 && (
            <Card>
              <p className="text-sm text-muted-foreground">
                {isOwner ? "No sort boxes yet. Make some above." : "No sort boxes yet. Ask the owner to make some."}
              </p>
            </Card>
          )}
          {boxes && boxes.length > 0 && (
            <ul className="divide-y divide-border rounded-xl border border-border bg-surface text-sm">
              {boxes.map((b) => (
                <li key={b.code} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-20 shrink-0 font-mono font-bold text-foreground">{b.code}</span>
                  <span className="min-w-0 flex-1">
                    {b.free ? (
                      <Badge tone="success">Free</Badge>
                    ) : (
                      <>
                        <span className="block truncate text-foreground">{b.manifestTitle ?? "A load"}</span>
                        <span className="block text-xs tabular-nums text-muted-foreground">
                          {b.unitsLeft} {b.unitsLeft === 1 ? "unit" : "units"} still in it
                        </span>
                      </>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Reprint ${b.code} label`}
                    onClick={() => reprint(b.code)}
                    disabled={busy}
                  >
                    <Printer className="size-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}
