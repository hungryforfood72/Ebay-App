"use client";

import type { ItemRow } from "@/app/api/bins/shared";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import { formatLocation } from "@/lib/warehouse/location";
import type { ItemLocation } from "@/lib/warehouse/types";
import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import {
  api,
  BannerPanel,
  beep,
  binName,
  errorText,
  focusField,
  ItemLine,
  plural,
  ScanStep,
  type Banner,
  type BinSummary,
  type LookupResult,
} from "./ui";

const FIELD = "putaway-scan";

type Candidate = { item: ItemRow; location: ItemLocation; notInBins: number };

// Putting units into a bin by hand: loose units found later, stock added
// on the Inventory page, or older items (shelf only, no label) being moved
// into bins. Scan the item label (or the product UPC for an older item),
// set how many, scan the bin. The bin scan saves it.
export function PutAwayPanel({ initialItemCode }: { initialItemCode?: string }) {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [choices, setChoices] = useState<Candidate[] | null>(null);
  const [units, setUnits] = useState("1");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(Boolean(initialItemCode));

  function choose(c: Candidate) {
    setCandidate(c);
    setChoices(null);
    setUnits(String(Math.max(1, c.notInBins)));
    focusField(FIELD);
  }

  // Opened from the Inventory page's "Put away" link with the item chosen.
  useEffect(() => {
    if (!initialItemCode) return;
    let cancelled = false;
    api<LookupResult>(`/api/bins/lookup?code=${encodeURIComponent(initialItemCode)}`)
      .then((r) => {
        if (cancelled || r.kind !== "item") return;
        setCandidate(r);
        setUnits(String(Math.max(1, r.notInBins)));
      })
      .catch((e) => !cancelled && setBanner({ tone: "danger", title: "Not found", lines: [errorText(e)] }))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [initialItemCode]);

  function fail(title: string, line?: string) {
    beep("error");
    setBanner({ tone: "danger", title, lines: line ? [line] : [] });
    focusField(FIELD);
  }

  async function findItem(code: string) {
    setBusy(true);
    try {
      const r = await api<LookupResult>(`/api/bins/lookup?code=${encodeURIComponent(code)}`);
      if (r.kind === "item") {
        beep("next");
        setBanner(null);
        choose(r);
      } else if (r.kind === "items") {
        beep("next");
        setBanner(null);
        if (r.items.length === 1) choose(r.items[0]);
        else {
          setCandidate(null);
          setChoices(r.items);
        }
      } else {
        fail("Scan the item first", "Then set how many, then scan the bin.");
      }
    } catch (e) {
      fail("Not found", errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function putInto(binCode: string) {
    if (!candidate) return;
    const n = Number(units);
    if (!Number.isInteger(n) || n < 1) return fail("How many?", "Set the number of units first.");
    setBusy(true);
    try {
      const res = await api<{ item: ItemRow; bin: BinSummary; location: ItemLocation; notInBins: number }>(
        "/api/bins/put-away",
        { itemId: candidate.item.id, binCode, units: n }
      );
      beep("ok");
      setBanner({
        tone: "success",
        title: `${plural(n, "unit")} ${res.bin.oversizedShelf ? "onto" : "into"} ${binName(res.bin)}`,
        lines: [
          res.item.title,
          res.bin.oversizedShelf
            ? "Oversized shelf: the item sits right on it."
            : res.bin.shelfLabel
              ? `${res.bin.code} is on shelf ${res.bin.shelfLabel}.`
              : `${res.bin.code} isn't shelved yet.`,
          res.notInBins > 0 ? `${plural(res.notInBins, "unit")} of this still not in a bin.` : "",
        ],
      });
      setCandidate(null);
      setUnits("1");
      focusField(FIELD);
    } catch (e) {
      fail("Not put away", errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function handleScan(raw: string) {
    const code = normalizeCode(raw);
    const kind = classifyScan(code);
    if (kind === "bin") {
      if (!candidate) return fail("Scan the item first", "Then set how many, then scan the bin.");
      void putInto(code);
      return;
    }
    // With an item ready, anything that isn't an item label or a UPC is
    // taken as an oversized shelf's label (the server says if it isn't).
    if (candidate && kind === "other") {
      void putInto(raw.trim());
      return;
    }
    // Anything else is an item (label, UPC or an older sku): start over
    // with that one.
    void findItem(raw);
  }

  const n = Number(units) || 0;
  // Focus goes straight back to the scan field: a scan landing on a
  // focused +/- button would "press" it with the scanner's Enter.
  function bump(by: number) {
    setUnits(String(Math.max(1, n + by)));
    focusField(FIELD);
  }
  return (
    <div className="flex flex-col gap-4">
      <ScanStep
        id={FIELD}
        label={candidate ? "Bin" : "Item"}
        prompt={candidate ? "Scan the bin it's going into" : "Scan the item label or UPC"}
        hint={
          candidate
            ? "Scanning the bin saves it. Scan a different item to switch."
            : "Older items have no label: scan the product barcode or type the UPC."
        }
        onScan={handleScan}
        disabled={busy}
      />

      {banner && <BannerPanel banner={banner} />}

      {choices && (
        <Card padded={false}>
          <p className="p-4 pb-2 text-sm font-medium text-foreground">Which one? ({choices.length} listings with this UPC)</p>
          <ul className="divide-y divide-border border-t border-border">
            {choices.map((c) => (
              <li key={c.item.id}>
                <button type="button" onClick={() => choose(c)} className="w-full px-4 py-3 text-left hover:bg-muted">
                  <ItemLine
                    item={c.item}
                    sub={<p className="mt-1 text-xs text-muted-foreground">{formatLocation(c.location)}</p>}
                    right={<span className="text-sm text-muted-foreground">{c.item.available} avail.</span>}
                  />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {candidate && (
        <Card>
          <ItemLine
            item={candidate.item}
            sub={<p className="mt-1 text-xs text-muted-foreground">Now: {formatLocation(candidate.location)}</p>}
          />
          <p className="mt-3 text-sm text-muted-foreground">
            {candidate.item.available} available,{" "}
            {candidate.notInBins > 0 ? (
              <span className="font-medium text-foreground">{candidate.notInBins} not in a bin yet</span>
            ) : (
              <span className="font-medium text-warning">all already in bins</span>
            )}
            .
          </p>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">Units</span>
            <Button variant="outline" size="icon-xl" aria-label="One less" onClick={() => bump(-1)}>
              <Minus className="size-5" aria-hidden />
            </Button>
            <Input
              size="lg"
              type="number"
              inputMode="numeric"
              min={1}
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              // Done typing: back to the scan field for the bin.
              onKeyDown={(e) => e.key === "Enter" && focusField(FIELD)}
              className="w-20 text-center"
              aria-label="Units"
            />
            <Button variant="outline" size="icon-xl" aria-label="One more" onClick={() => bump(1)}>
              <Plus className="size-5" aria-hidden />
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            A unit is one of the listing (a 3-pack listing counts each bag of 3 as one).
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => {
              setCandidate(null);
              focusField(FIELD);
            }}
          >
            Pick a different item
          </Button>
        </Card>
      )}
    </div>
  );
}
