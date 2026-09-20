"use client";

import Link from "next/link";
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

type LiveCheck = {
  liveAvailableQuantity: number | null;
  livePrice: number | null;
  storedAvailableQuantity: number;
};

// Search by eBay Item ID, title, UPC, or our own SKU across every listing
// this app has published/linked to eBay — the fix for eBay's Seller Hub
// blocking manual quantity edits on API-managed listings ("refer to the
// tool used to create this listing"). This IS that tool.
export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [liveCheck, setLiveCheck] = useState<LiveCheck | null>(null);
  const [checkingLive, setCheckingLive] = useState(false);
  const [quantityInput, setQuantityInput] = useState("");
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
    setQuantityInput(String(item.availableQuantity));
    setCheckingLive(true);
    try {
      const res = await fetch(`/api/items/${item.id}/quantity`);
      const data: LiveCheck = await res.json();
      setLiveCheck(data);
      // The live number from eBay itself is the more trustworthy starting
      // point once we have it — the whole reason this page's edit exists
      // is that the stored/DB number can drift from what's actually live.
      if (data.liveAvailableQuantity != null) {
        setQuantityInput(String(data.liveAvailableQuantity));
      }
    } catch {
      // Best-effort — editing still works off the stored number if the
      // live check itself fails.
    } finally {
      setCheckingLive(false);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setLiveCheck(null);
    setRowError(null);
  }

  async function saveQuantity(item: InventoryItem) {
    const value = Number(quantityInput);
    if (!Number.isInteger(value) || value < 0) {
      setRowError("Enter a whole number, 0 or more.");
      return;
    }
    setSaving(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/quantity`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ availableQuantity: value }),
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
                      Edit quantity
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
                              (our records said {liveCheck.storedAvailableQuantity} — using the live number)
                            </span>
                          )}
                        </p>
                      ) : (
                        <p className="text-xs text-gray-500">
                          Couldn&apos;t reach eBay for a live check — showing our records ({liveCheck.storedAvailableQuantity}).
                        </p>
                      )
                    ) : null}
                    <div className="mt-2 flex items-center gap-2">
                      <label className="text-xs font-medium text-gray-500">Set available quantity to</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={quantityInput}
                        onChange={(e) => setQuantityInput(e.target.value)}
                        className="w-24 rounded border px-2 py-1 text-sm"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => saveQuantity(item)}
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
