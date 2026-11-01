"use client";

import { StationPicker, useChosenStation } from "@/components/StationPicker";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { LoaderCircle, Printer } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// Sort boxes (SB0001...): the boxes good units go in at the sort station.
// Since 2026-11-01 they aren't reused: the sorter starts a new one for the
// load on the Sort page (label prints with the load's name), so this page
// is just the list plus a reprint for a torn label. "Retired" = made in bulk
// before that rule and never used (SB0011-SB0040); they can't be used.

// GET /api/sort-boxes
type SortBoxRow = {
  code: string;
  manifestId: string | null;
  manifestTitle: string | null;
  unitsLeft: number;
  unitsSorted: number;
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
  const stations = useChosenStation(true);
  const [boxes, setBoxes] = useState<SortBoxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
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

  const inUse = boxes?.filter((b) => b.unitsLeft > 0).length ?? 0;

  return (
    <AppShell
      width="medium"
      title="Sort boxes"
      subtitle="Start new ones on the Sort page. Boxes aren't reused."
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

        <section>
          <SectionHeader
            title="All sort boxes"
            action={boxes ? <Badge>{`${inUse} with units in them`}</Badge> : undefined}
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
                No sort boxes yet. Start one on the Sort page.
              </p>
            </Card>
          )}
          {boxes && boxes.length > 0 && (
            <ul className="divide-y divide-border rounded-xl border border-border bg-surface text-sm">
              {boxes.map((b) => (
                <li key={b.code} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-20 shrink-0 font-mono font-bold text-foreground">{b.code}</span>
                  <span className="min-w-0 flex-1">
                    {!b.manifestId ? (
                      <Badge>Retired</Badge>
                    ) : (
                      <>
                        <span className="block truncate text-foreground">{b.manifestTitle ?? "A load"}</span>
                        <span className="block text-xs tabular-nums text-muted-foreground">
                          {b.unitsLeft > 0
                            ? `${b.unitsLeft} ${b.unitsLeft === 1 ? "unit" : "units"} still in it`
                            : "Empty, all pulled to listing"}
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
