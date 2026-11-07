"use client";

import { PrintToStation } from "@/app/bins/ui";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Input";
import { Download, Gift, Package } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

// The Whatnot page's show pieces (Cristian, 2026-11-07): the reusable show
// boxes (one per buyer during a show, packed after it) and the giveaway CSV.

export type ShowBoxRow = { number: number; code: string; inUse: { buyer: string | null; show: string } | null };
export type GiveawayBinRow = { code: string; shelf: string | null; units: number };
export type GiveawayExportRow = { id: string; show: string | null; bins: string[]; rows: number; by: string | null; at: string };
type ShowOption = { id: string; title: string; startsAt: string | null };

async function post(body: Record<string, unknown>) {
  const r = await fetch("/api/whatnot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(data?.error ?? "Something went wrong.") as Error & { duplicate?: boolean; skipped?: unknown };
    err.duplicate = data?.duplicate === true;
    err.skipped = data?.skipped;
    throw err;
  }
  return data;
}

export function ShowBoxesCard({ boxes, onChanged }: { boxes: ShowBoxRow[]; onChanged: () => void }) {
  const [upTo, setUpTo] = useState(String(Math.max(50, boxes.length)));
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState(String(Math.max(1, boxes.length)));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const inUse = boxes.filter((b) => b.inUse);

  async function make() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await post({ action: "show_boxes", upTo: Number(upTo) });
      setMessage({ ok: true, text: r.made ? `Made ${r.made} show box${r.made === 1 ? "" : "es"}. Print their labels below.` : "Those boxes already exist." });
      setTo(upTo);
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function free(n: number) {
    if (!confirm(`Free show box ${n}? Only do this if it's really empty (its order was packed some other way).`)) return;
    setBusy(true);
    try {
      await post({ action: "free_box", number: n });
      onChanged();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Show boxes"
        description="Reusable bins, one per buyer during a show. A buyer's first buy gets the lowest free box, and everything else they win goes in it. After the show, packing mode checks each box and prints its label, and the box is free again."
        action={
          <span className="flex flex-wrap gap-2">
            <Link href="/show" className={buttonClasses({ variant: "outline", size: "sm" })}>
              Show screen
            </Link>
            <Link href="/show/pack" className={buttonClasses({ variant: "outline", size: "sm" })}>
              <Package className="size-4" aria-hidden />
              Packing
            </Link>
          </span>
        }
      />
      <p className="mb-3 text-sm text-muted-foreground">
        {boxes.length === 0 ? "No show boxes yet." : `${boxes.length} boxes · ${inUse.length} in use · ${boxes.length - inUse.length} free`}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Boxes 1 to" className="w-28">
          <Input type="number" min={1} max={300} value={upTo} onChange={(e) => setUpTo(e.target.value)} />
        </Field>
        <Button onClick={make} disabled={busy}>
          {boxes.length ? "Make more" : "Make show boxes"}
        </Button>
      </div>
      {boxes.length > 0 && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <Field label="Print labels from" className="w-24">
            <Input type="number" min={1} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="to" className="w-24">
            <Input type="number" min={1} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <PrintToStation
            label="Print"
            disabled={busy}
            onPrint={async (stationId) => {
              const r = await post({ action: "print_show_boxes", stationId, from: Number(from), to: Number(to) });
              return `Sent ${r.queued} label${r.queued === 1 ? "" : "s"} to the printer.`;
            }}
          />
        </div>
      )}
      {message && (
        <p className={`mt-2 text-sm ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>
      )}
      {inUse.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium">In use ({inUse.length})</summary>
          <ul className="mt-2 divide-y divide-border">
            {inUse.map((b) => (
              <li key={b.number} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  <span className="font-semibold">Box {b.number}</span> · {b.inUse!.buyer ? `@${b.inUse!.buyer}` : "a buyer"} ·{" "}
                  <span className="text-muted-foreground">{b.inUse!.show}</span>
                </span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => free(b.number)}>
                  Free it
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

export function GiveawaysCard({
  bins,
  shows,
  exports,
  onChanged,
}: {
  bins: GiveawayBinRow[];
  shows: ShowOption[];
  exports: GiveawayExportRow[];
  onChanged: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showId, setShowId] = useState(shows[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [result, setResult] = useState<{ rows: { sku: string; title: string; quantity: number }[]; skipped: { sku: string; title: string; reason: string }[] } | null>(
    null
  );

  async function make(force: boolean) {
    setBusy(true);
    setError(null);
    setDuplicate(false);
    setResult(null);
    try {
      const r = await post({ action: "giveaway_csv", binCodes: [...picked], showId: showId || null, force });
      // The file, straight to Downloads: upload it on whatnot.com (Shows >
      // the show > Add > Create Temporary Listing > Upload CSV).
      const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setResult({ rows: r.rows, skipped: r.skipped });
      onChanged();
    } catch (e) {
      const err = e as Error & { duplicate?: boolean; skipped?: { sku: string; title: string; reason: string }[] };
      setError(err.message);
      setDuplicate(err.duplicate === true);
      if (Array.isArray(err.skipped)) setResult({ rows: [], skipped: err.skipped });
    } finally {
      setBusy(false);
    }
  }

  const units = bins.filter((b) => picked.has(b.code)).reduce((n, b) => n + b.units, 0);
  return (
    <Card>
      <SectionHeader
        title="Giveaways"
        description="Pick giveaway bins and get them as a Whatnot CSV. On whatnot.com (a computer, not the app): Shows, open the show, Add, Create Temporary Listing, Upload CSV. Each listing's SKU is its label code, so scanning the label finds it in the show."
      />
      {bins.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No giveaway bins yet. Make them on the Bins page (tick Giveaway bins), then list giveaways with Giveaway mode on the List page.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {bins.map((b) => (
              <label
                key={b.code}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${picked.has(b.code) ? "border-purple-400 bg-purple-50" : "border-border"}`}
              >
                <input
                  type="checkbox"
                  className="size-4"
                  checked={picked.has(b.code)}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(b.code);
                      else next.delete(b.code);
                      return next;
                    })
                  }
                />
                <Gift className="size-4 text-purple-600" aria-hidden />
                <span className="font-mono font-semibold">{b.code}</span>
                <span className="text-muted-foreground">
                  {b.units} unit{b.units === 1 ? "" : "s"}
                  {b.shelf ? ` · ${b.shelf}` : ""}
                </span>
              </label>
            ))}
          </div>
          <Field label="For which show" hint="So the same bins don't go on the same show twice.">
            <Select value={showId} onChange={(e) => setShowId(e.target.value)}>
              <option value="">No show picked</option>
              {shows.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <Button onClick={() => make(false)} disabled={busy || picked.size === 0}>
              <Download className="size-4" aria-hidden />
              {busy ? "Making…" : picked.size ? `Download CSV (${units} unit${units === 1 ? "" : "s"})` : "Pick a bin"}
            </Button>
          </div>
          {error && (
            <Alert tone={duplicate ? "warning" : "danger"}>
              {error}
              {duplicate && (
                <span className="mt-2 block">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => make(true)}>
                    Make it anyway
                  </Button>
                </span>
              )}
            </Alert>
          )}
          {result && (
            <div className="text-sm">
              {result.rows.length > 0 && (
                <p className="text-success">
                  {result.rows.length} giveaway listing{result.rows.length === 1 ? "" : "s"} in the file ({result.rows.reduce((n, r) => n + r.quantity, 0)} units).
                </p>
              )}
              {result.skipped.length > 0 && (
                <div className="mt-2">
                  <p className="font-medium">Left out</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {result.skipped.map((s) => (
                      <li key={s.sku}>
                        <span className="font-mono">{s.sku}</span> {s.title}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {exports.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Made before</summary>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {exports.map((x) => (
                  <li key={x.id}>
                    {new Date(x.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ·{" "}
                    {x.show ?? "no show picked"} · {x.bins.join(", ")} · {x.rows} listing{x.rows === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}
