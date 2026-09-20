"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { UserNavLinks } from "@/components/UserNav";

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
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Inventory</h1>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm underline">
            Dashboard
          </Link>
          <Link href="/manifests" className="text-sm underline">
            Manifests
          </Link>
          <Link href="/analyzer" className="text-sm underline">
            Analyzer
          </Link>
          <UserNavLinks />
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-500">Every active eBay listing this app has published or linked.</p>

      <form onSubmit={search} className="mb-6 flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by eBay Item ID, title, UPC, or SKU"
          className="flex-1 rounded border px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded bg-black px-4 py-2 text-sm text-white">
          Search
        </button>
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              load("");
            }}
            className="rounded border px-4 py-2 text-sm"
          >
            Clear
          </button>
        )}
      </form>

      {!items ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">No active listings match that search.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const listingUrl = item.ebayListingId
              ? item.ebayEnvironment === "production"
                ? `https://www.ebay.com/itm/${item.ebayListingId}`
                : `https://sandbox.ebay.com/itm/${item.ebayListingId}`
              : null;
            const isEditing = editingId === item.id;
            const currentKnown = liveCheck?.liveAvailableQuantity ?? liveCheck?.storedAvailableQuantity ?? item.availableQuantity;
            const amount = Number(amountInput);
            const preview =
              Number.isInteger(amount) && amount > 0
                ? direction === "add"
                  ? currentKnown + amount
                  : currentKnown - amount
                : null;

            return (
              <div key={item.id} className="rounded-lg border p-3">
                <div className="flex items-start gap-3">
                  {item.photoUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.photoUrl} alt="" className="h-16 w-16 flex-shrink-0 rounded object-cover" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{item.title ?? item.sku}</p>
                    <p className="text-xs text-gray-400">
                      {item.upc ?? "no UPC"} · {item.shelfLocation}
                      {item.isMultipack && item.packSize ? ` · ${item.packSize}-pack` : ""}
                      {listingUrl && (
                        <>
                          {" · "}
                          <a href={listingUrl} target="_blank" rel="noreferrer" className="underline">
                            Item {item.ebayListingId}
                          </a>
                        </>
                      )}
                    </p>
                    <p className="mt-1 text-sm text-gray-600">
                      ${item.price?.toFixed(2) ?? "—"} · Available: <strong>{item.availableQuantity}</strong>
                      {item.soldQuantity > 0 && (
                        <span className="text-gray-400"> ({item.quantity} listed, {item.soldQuantity} sold)</span>
                      )}
                    </p>
                  </div>
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => startEdit(item)}
                      className="flex-shrink-0 rounded border px-3 py-1.5 text-xs"
                    >
                      Adjust stock
                    </button>
                  )}
                </div>

                {isEditing && (
                  <div className="mt-3 rounded-lg border bg-gray-50 p-3">
                    {checkingLive ? (
                      <p className="text-xs text-gray-500">Checking live quantity on eBay…</p>
                    ) : liveCheck ? (
                      liveCheck.liveAvailableQuantity != null ? (
                        <p className="text-xs text-gray-500">
                          Live on eBay right now: <strong>{liveCheck.liveAvailableQuantity}</strong> available
                          {liveCheck.liveAvailableQuantity !== liveCheck.storedAvailableQuantity && (
                            <span className="text-orange-600">
                              {" "}
                              (our records said {liveCheck.storedAvailableQuantity})
                            </span>
                          )}
                          {" — the server re-checks this again right before saving, so it stays accurate even if a sale lands while you type."}
                        </p>
                      ) : (
                        <p className="text-xs text-gray-500">
                          Couldn&apos;t reach eBay for a live check — showing our records ({liveCheck.storedAvailableQuantity}).
                        </p>
                      )
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <div className="flex rounded border overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setDirection("add")}
                          className={`px-3 py-1.5 text-sm ${direction === "add" ? "bg-black text-white" : "bg-white text-gray-700"}`}
                        >
                          Add
                        </button>
                        <button
                          type="button"
                          onClick={() => setDirection("remove")}
                          className={`px-3 py-1.5 text-sm ${direction === "remove" ? "bg-black text-white" : "bg-white text-gray-700"}`}
                        >
                          Remove
                        </button>
                      </div>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={amountInput}
                        onChange={(e) => setAmountInput(e.target.value)}
                        placeholder="Amount"
                        className="w-24 rounded border px-2 py-1 text-sm"
                        autoFocus
                      />
                      {preview != null && (
                        <span className="text-xs text-gray-500">
                          → new available: <strong>{Math.max(0, preview)}</strong>
                        </span>
                      )}
                    </div>

                    <input
                      type="text"
                      value={noteInput}
                      onChange={(e) => setNoteInput(e.target.value)}
                      placeholder="Note — why is this stock changing? (required)"
                      className="mt-2 w-full rounded border px-2 py-1.5 text-sm"
                    />

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => saveAdjustment(item)}
                        disabled={saving}
                        className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-40"
                      >
                        {saving ? "Saving…" : "Save to eBay"}
                      </button>
                      <button type="button" onClick={cancelEdit} className="text-sm text-gray-500 underline">
                        Cancel
                      </button>
                    </div>
                    {rowError && <p className="mt-2 text-sm text-red-600">{rowError}</p>}

                    {liveCheck && liveCheck.recentAdjustments.length > 0 && (
                      <div className="mt-3 border-t pt-2">
                        <p className="mb-1 text-xs font-medium text-gray-500">Recent adjustments</p>
                        <ul className="flex flex-col gap-1">
                          {liveCheck.recentAdjustments.map((adj) => (
                            <li key={adj.id} className="text-xs text-gray-500">
                              {new Date(adj.createdAt).toLocaleString()} —{" "}
                              <span className={adj.delta >= 0 ? "text-green-700" : "text-red-600"}>
                                {adj.delta >= 0 ? `+${adj.delta}` : adj.delta}
                              </span>{" "}
                              ({adj.previousAvailable} → {adj.newAvailable}): {adj.note}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
