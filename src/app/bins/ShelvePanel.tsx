"use client";

import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import { useState } from "react";
import {
  api,
  BannerPanel,
  beep,
  binCounts,
  ConfirmEmptyButton,
  describeShelf,
  errorText,
  focusField,
  plural,
  ScanStep,
  type Banner,
  type BinSummary,
  type ShelfState,
} from "./ui";

const FIELD = "shelve-scan";

// Shelving bins: scan a shelf, then every bin going on it, one after
// another. The shelf stays picked until you scan a different shelf or tap
// Change, so a cart of bins for A5 is one shelf scan plus a scan per bin.
// Scanning a bin first works too: it waits for the shelf.
//
// The list at the bottom is what to grab: bins closed at the binning
// station and not on a shelf yet. Shelving a bin nobody closed closes it.
//
// Warehouse cutover: a shelf still holding old-system items refuses bins.
// Each shelf scan asks the server for its state; one that "looks empty"
// gets a Confirm button right here, for whoever is looking at it.
export function ShelvePanel({
  bins,
  onShelved,
}: {
  bins: BinSummary[] | null;
  onShelved: () => void;
}) {
  const [shelf, setShelf] = useState<string | null>(null);
  const [waitingBin, setWaitingBin] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [done, setDone] = useState<{ code: string; shelf: string; counts: string }[]>([]);
  // A scanned shelf that can't take bins yet, but looks empty: show Confirm.
  const [confirmShelf, setConfirmShelf] = useState<string | null>(null);

  function pickShelf(label: string) {
    setShelf(label);
    setConfirmShelf(null);
    if (waitingBin) {
      setWaitingBin(null);
      void shelve(waitingBin, label);
    } else {
      beep("next");
      setBanner({ tone: "info", title: `Shelf ${label}`, lines: ["Now scan each bin going on it."] });
      focusField(FIELD);
    }
  }

  async function checkShelf(raw: string) {
    try {
      const { shelf: state } = await api<{ shelf: ShelfState }>(`/api/bins/shelves?label=${encodeURIComponent(raw.trim())}`);
      if (state.state === "free" || state.state === "bins") return pickShelf(state.label);
      beep("error");
      setShelf(null);
      setConfirmShelf(state.state === "looks_empty" ? state.label : null);
      setBanner({
        tone: "danger",
        title: state.state === "looks_empty" ? `Shelf ${state.label}: check it first` : `Shelf ${state.label} isn't ready for bins`,
        lines: [
          state.state === "looks_empty"
            ? `The records say the old items on ${state.label} are gone. Look: if it's really empty, confirm below.`
            : `Still ${describeShelf(state)}. Bins can go here once it's empty.`,
        ],
      });
    } catch (e) {
      beep("error");
      setBanner({ tone: "danger", title: `No shelf called "${raw.trim()}"`, lines: [errorText(e)] });
    } finally {
      focusField(FIELD);
    }
  }

  // Not blocked while saving: a quick next scan shouldn't be dropped, and
  // each bin saves on its own.
  async function shelve(binCode: string, shelfLabel: string) {
    try {
      const res = await api<{ bin: BinSummary; previousShelf: string | null }>("/api/bins/shelve", {
        binCode,
        shelfLabel,
      });
      beep("ok");
      setBanner({
        tone: "success",
        title: `${res.bin.code} on shelf ${res.bin.shelfLabel}`,
        lines: [
          binCounts(res.bin),
          res.previousShelf && res.previousShelf !== res.bin.shelfLabel ? `Moved from shelf ${res.previousShelf}.` : "",
          "Scan the next bin.",
        ],
      });
      setDone((prev) => [{ code: res.bin.code, shelf: res.bin.shelfLabel!, counts: binCounts(res.bin) }, ...prev].slice(0, 30));
      onShelved();
    } catch (e) {
      beep("error");
      setBanner({ tone: "danger", title: "Not shelved", lines: [errorText(e)] });
    } finally {
      focusField(FIELD);
    }
  }

  function handleScan(raw: string) {
    const code = normalizeCode(raw);
    const kind = classifyScan(code);
    if (kind === "bin") {
      if (shelf) {
        void shelve(code, shelf);
      } else {
        setWaitingBin(code);
        beep("next");
        setBanner({ tone: "info", title: `${code}: now scan its shelf` });
      }
      return;
    }
    if (kind === "item" || kind === "upc" || kind === "box") {
      beep("error");
      setBanner({
        tone: "danger",
        title: kind === "item" ? "That's an item label" : kind === "box" ? "That's a box label" : "That's a product barcode",
        lines: ["Scan a shelf label or a bin label."],
      });
      return;
    }
    void checkShelf(raw);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shelving onto</p>
          <p className="text-3xl font-bold tracking-tight text-foreground">{shelf ? `Shelf ${shelf}` : "No shelf yet"}</p>
          {waitingBin && <p className="mt-1 text-sm text-primary">{waitingBin} is waiting for a shelf scan.</p>}
        </div>
        {(shelf || waitingBin) && (
          <Button
            variant="outline"
            onClick={() => {
              setShelf(null);
              setWaitingBin(null);
              setConfirmShelf(null);
              setBanner(null);
              focusField(FIELD);
            }}
          >
            Change
          </Button>
        )}
      </div>

      <ScanStep
        id={FIELD}
        label={shelf ? "Bin" : "Shelf or bin"}
        prompt={shelf ? `Scan a bin for shelf ${shelf}` : waitingBin ? "Scan the shelf" : "Scan the shelf first"}
        hint={
          shelf
            ? "Each bin you scan goes on this shelf. Scan another shelf to switch."
            : "Shelf first, then each bin going on it. A bin then its shelf works too."
        }
        onScan={handleScan}
      />

      {banner && <BannerPanel banner={banner} />}

      {confirmShelf && <ConfirmEmptyButton shelf={confirmShelf} size="xl" onConfirmed={(s) => pickShelf(s.label)} />}

      <ReadyList bins={bins} />

      {done.length > 0 && (
        <Card padded={false}>
          <SectionHeader title={`Shelved just now (${done.length})`} className="mb-0 p-4 pb-2" />
          <ul className="divide-y divide-border border-t border-border text-sm">
            {done.map((d, i) => (
              <li key={`${d.code}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="font-mono font-medium text-foreground">{d.code}</span>
                <span className="text-muted-foreground">
                  Shelf {d.shelf} · {d.counts}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ReadyList({ bins }: { bins: BinSummary[] | null }) {
  if (!bins) return null;
  const ready = bins.filter((b) => b.status === "ready");
  const open = bins.filter((b) => b.status === "filling").length;
  return (
    <Card padded={false}>
      <SectionHeader
        title={`Ready to shelve (${ready.length})`}
        description={
          ready.length === 0
            ? "No closed bins waiting. They show up here when the binning station taps Close bin."
            : "Closed at the binning station. Grab these and shelve them."
        }
        className="mb-0 p-4 pb-3"
      />
      {ready.length > 0 && (
        <ul className="divide-y divide-border border-t border-border text-sm">
          {ready.map((b) => (
            <li key={b.code} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="font-mono font-medium text-foreground">{b.code}</span>
              <span className="text-muted-foreground">{binCounts(b)}</span>
            </li>
          ))}
        </ul>
      )}
      {open > 0 && (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {plural(open, "bin")} still open at the binning station.
        </p>
      )}
    </Card>
  );
}
