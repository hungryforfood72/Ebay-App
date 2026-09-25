"use client";

import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/Input";
import { ExternalLink, LoaderCircle, Minus, Package, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";

type InventoryItem = {
  id: string;
  title: string | null;
  sku: string;
  upc: string | null;
  shelfLocation: string;
  price: number | null;
  quantity: number;
  soldQuantity: number;
  availableQuantity: number;
  isMultipack: boolean;
  packSize: number | null;
  ebayListingId: string | null;
  ebayOfferId: string | null;
  ebayEnvironment: string | null;
  photoUrl: string | null;
};

type StockAdjustment = {
  id: string;
  delta: number;
  previousAvailable: number;
  newAvailable: number;
  note: string;
  recordedBy: string | null;
  createdAt: string;
};

type LiveCheck = {
  liveAvailableQuantity: number | null;
  livePrice: number | null;
  storedAvailableQuantity: number;
  recentAdjustments: StockAdjustment[];
};

// Search by eBay Item ID, title, UPC, or our own SKU across every listing
// this app has published/linked to eBay — the fix for eBay's Seller Hub
// blocking manual quantity edits on API-managed listings ("refer to the
// tool used to create this listing"). This IS that tool.
//
// Add/remove by a signed amount, not "set the total to X" — typing a new
// absolute total based on whatever the screen showed when editing opened
// races a real-time sale (Cristian's own example: 5 available, means to
// add 5 more, types "10" — but if it's really down to 4 by submit time,
// "10" silently overwrites that sale instead of landing on the correct
// 9). The server re-checks the live eBay quantity again right before
// applying the delta, so what actually gets used is whatever was true at
// submit time, not open time.
export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [liveCheck, setLiveCheck] = useState<LiveCheck | null>(null);
  const [checkingLive, setCheckingLive] = useState(false);
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [amountInput, setAmountInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  function load(q: string) {
    fetch(`/api/inventory${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => r.json())
      .then((data: { items: InventoryItem[] }) => setItems(data.items));
  }

  useEffect(() => load(""), []);

  function search(e: React.FormEvent) {
    e.preventDefault();
    load(query);
  }

  async function startEdit(item: InventoryItem) {
    setEditingId(item.id);
    setRowError(null);
    setLiveCheck(null);
    setDirection("add");
    setAmountInput("");
    setNoteInput("");
    setCheckingLive(true);
    try {
      const res = await fetch(`/api/items/${item.id}/quantity`);
      const data: LiveCheck = await res.json();
      setLiveCheck(data);
    } catch {
      // Best-effort — the amount/note fields still work even if this
      // preview check fails; the actual save re-checks live again anyway.
    } finally {
      setCheckingLive(false);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setLiveCheck(null);
    setRowError(null);
  }

  async function saveAdjustment(item: InventoryItem) {
    const amount = Number(amountInput);
    if (!Number.isInteger(amount) || amount <= 0) {
      setRowError("Enter a whole number greater than 0.");
      return;
    }
    if (!noteInput.trim()) {
      setRowError("A note is required — say why this stock is changing.");
      return;
    }
    setSaving(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/quantity`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, amount, note: noteInput.trim() }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Failed to update quantity.");
      setItems((prev) =>
        prev
          ? prev.map((i) =>
              i.id === item.id
                ? { ...i, quantity: result.quantity, soldQuantity: result.soldQuantity, availableQuantity: result.availableQuantity }
                : i
            )
          : prev
      );
      setEditingId(null);
      setLiveCheck(null);
    } catch (e) {
      setRowError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell title="Inventory" subtitle="Every active eBay listing this app has published or linked.">
      <div className="flex flex-col gap-5">
        <form onSubmit={search} className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              size="sm"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="eBay Item ID, title, UPC, or SKU"
              aria-label="Search inventory"
              className="pl-10"
            />
          </div>
          <Button type="submit">
            Search
          </Button>
          {query && (
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                load("");
              }}
            >
              Clear
            </Button>
          )}
        </form>

        {!items ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">No active listings match that search.</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((item) => {
              const listingUrl = item.ebayListingId
                ? item.ebayEnvironment === "production"
                  ? `https://www.ebay.com/itm/${item.ebayListingId}`
                  : `https://sandbox.ebay.com/itm/${item.ebayListingId}`
                : null;
              const isEditing = editingId === item.id;
              const currentKnown =
                liveCheck?.liveAvailableQuantity ?? liveCheck?.storedAvailableQuantity ?? item.availableQuantity;
              const amount = Number(amountInput);
              const preview =
                Number.isInteger(amount) && amount > 0
                  ? direction === "add"
                    ? currentKnown + amount
                    : currentKnown - amount
                  : null;

              return (
                <Card key={item.id} className={cn(isEditing && "ring-2 ring-primary/30")}>
                  <div className="flex items-start gap-3">
                    {item.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.photoUrl}
                        alt=""
                        className="size-16 shrink-0 rounded-lg border border-border object-cover"
                      />
                    ) : (
                      <span className="grid size-16 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                        <Package className="size-6" aria-hidden />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 font-medium leading-snug text-foreground">{item.title ?? item.sku}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <Badge>Shelf {item.shelfLocation}</Badge>
                        {item.isMultipack && item.packSize ? <Badge tone="primary">{item.packSize}-pack</Badge> : null}
                        <span className="tabular-nums">{item.upc ?? "no UPC"}</span>
                        {listingUrl && (
                          <a
                            href={listingUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="-my-2 inline-flex items-center gap-1 py-2 font-medium text-primary hover:underline"
                          >
                            eBay
                            <ExternalLink className="size-3" aria-hidden />
                          </a>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        <span className="font-medium text-foreground">${item.price?.toFixed(2) ?? "—"}</span>
                        {" · "}
                        <span className="font-semibold text-foreground">{item.availableQuantity}</span> available
                        {item.soldQuantity > 0 && (
                          <span>
                            {" "}
                            ({item.quantity} listed, {item.soldQuantity} sold)
                          </span>
                        )}
                      </p>
                    </div>
                    {!isEditing && (
                      <Button variant="outline" size="sm" onClick={() => startEdit(item)} className="shrink-0">
                        Adjust
                      </Button>
                    )}
                  </div>

                  {isEditing && (
                    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
                      {checkingLive ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <LoaderCircle className="size-4 animate-spin" aria-hidden />
                          Checking live quantity on eBay…
                        </p>
                      ) : liveCheck ? (
                        liveCheck.liveAvailableQuantity != null ? (
                          <p className="text-sm text-muted-foreground">
                            Live on eBay right now:{" "}
                            <strong className="text-foreground">{liveCheck.liveAvailableQuantity}</strong> available
                            {liveCheck.liveAvailableQuantity !== liveCheck.storedAvailableQuantity && (
                              <span className="font-medium text-warning">
                                {" "}
                                (our records said {liveCheck.storedAvailableQuantity})
                              </span>
                            )}
                            . The server re-checks this right before saving, so it stays accurate even if a sale
                            lands while you type.
                          </p>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            Couldn&apos;t reach eBay for a live check — showing our records (
                            {liveCheck.storedAvailableQuantity}).
                          </p>
                        )
                      ) : null}

                      <div className="flex flex-wrap items-center gap-3">
                        <div className="inline-flex rounded-lg bg-muted p-1" role="group" aria-label="Direction">
                          {(["add", "remove"] as const).map((d) => (
                            <button
                              key={d}
                              type="button"
                              onClick={() => setDirection(d)}
                              aria-pressed={direction === d}
                              className={cn(
                                "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
                                direction === d
                                  ? "bg-surface text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              )}
                            >
                              {d === "add" ? <Plus className="size-4" aria-hidden /> : <Minus className="size-4" aria-hidden />}
                              {d === "add" ? "Add" : "Remove"}
                            </button>
                          ))}
                        </div>
                        <div className="w-28">
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            value={amountInput}
                            onChange={(e) => setAmountInput(e.target.value)}
                            placeholder="Amount"
                            aria-label="Amount"
                            autoFocus
                          />
                        </div>
                        {preview != null && (
                          <span className="text-sm text-muted-foreground">
                            → new available:{" "}
                            <strong className="text-foreground">{Math.max(0, preview)}</strong>
                          </span>
                        )}
                      </div>

                      <Input
                        type="text"
                        value={noteInput}
                        onChange={(e) => setNoteInput(e.target.value)}
                        placeholder="Why is this stock changing? (required)"
                        aria-label="Note"
                      />

                      <div className="flex items-center gap-2">
                        <Button onClick={() => saveAdjustment(item)} disabled={saving}>
                          {saving ? "Saving…" : "Save to eBay"}
                        </Button>
                        <Button variant="ghost" onClick={cancelEdit}>
                          Cancel
                        </Button>
                      </div>
                      {rowError && <p className="text-sm font-medium text-danger">{rowError}</p>}

                      {liveCheck && liveCheck.recentAdjustments.length > 0 && (
                        <div className="rounded-lg bg-background p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Recent adjustments
                          </p>
                          <ul className="flex flex-col gap-1.5">
                            {liveCheck.recentAdjustments.map((adj) => (
                              <li key={adj.id} className="text-xs text-muted-foreground">
                                <span
                                  className={cn(
                                    "mr-1.5 font-semibold tabular-nums",
                                    adj.delta >= 0 ? "text-success" : "text-danger"
                                  )}
                                >
                                  {adj.delta >= 0 ? `+${adj.delta}` : adj.delta}
                                </span>
                                ({adj.previousAvailable} → {adj.newAvailable}) {adj.note}
                                <span className="block opacity-80">{new Date(adj.createdAt).toLocaleString()}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
