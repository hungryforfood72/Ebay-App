"use client";

import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { ChevronDown, PackageX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

// "Pull these from the bins" on the List page (Cristian, 2026-10-25), so the
// people at the scanners see it without going to the Dashboard: listings
// that came off eBay for their date, or because the package says Rx Only
// (those go back to the supplier). Same list and same "Mark as pulled" as
// the Dashboard (GET /api/pulls). Listings that need a relist split stay on
// the Dashboard.

type PullItem = {
  id: string;
  finalTitle: string | null;
  sku: string;
  shelfLocation: string | null;
  pullReason: string | null;
  location: { bins: { binCode: string; shelfLabel: string | null; units: number }[]; legacyShelf: string | null } | null;
};

const REFRESH_MS = 60_000;

export function PullBanner() {
  const [items, setItems] = useState<PullItem[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/pulls", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems(d.items ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  async function markPulled(id: string) {
    setSaving(id);
    setError(null);
    try {
      const res = await fetch(`/api/items/${id}/acknowledge-shelf-pull`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't save.");
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(null);
    }
  }

  if (items.length === 0) return null;
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 text-red-950">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <PackageX className="size-5 shrink-0 text-danger" aria-hidden />
        <span className="flex-1 text-sm font-semibold">
          {items.length} {items.length === 1 ? "listing" : "listings"} to pull from the bins
        </span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <ul className="flex flex-col gap-2 border-t border-red-200 p-3">
          {items.map((item) => (
            <li key={item.id} className="rounded-lg border border-red-200 bg-surface p-2.5">
              <p className="line-clamp-2 text-sm font-medium text-foreground">{item.finalTitle ?? item.sku}</p>
              <p className="text-xs text-muted-foreground">
                {item.sku} ·{" "}
                {item.pullReason === "rx_return" ? (
                  <span className="font-medium text-danger">Rx only: set aside to go back to the supplier</span>
                ) : (
                  "came off eBay for its date"
                )}
              </p>
              <p className="mt-1 text-sm text-foreground">
                <span className="font-medium">Pull from:</span>{" "}
                {item.location && item.location.bins.length > 0
                  ? item.location.bins
                      .map((b) => `${b.binCode}${b.shelfLabel ? ` (shelf ${b.shelfLabel})` : ""}: ${b.units}`)
                      .join(" · ")
                  : (item.location?.legacyShelf ?? item.shelfLocation ?? "its shelf")}
              </p>
              <Button size="sm" className="mt-2" onClick={() => markPulled(item.id)} disabled={saving === item.id}>
                {saving === item.id ? "Saving…" : "Pulled them all"}
              </Button>
            </li>
          ))}
          {error && <li className="text-xs text-danger">{error}</li>}
        </ul>
      )}
    </div>
  );
}
