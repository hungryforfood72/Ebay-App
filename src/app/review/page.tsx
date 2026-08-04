"use client";

import { useEffect, useState } from "react";

type Item = {
  id: string;
  sku: string;
  status: "pending_review" | "ready" | "exported";
  upc: string;
  quantity: number;
  isMultipack: boolean;
  packSize: number | null;
  expirationDate: string | null;
  shelfLocation: string;
  photoUrls: string[];
  finalTitle: string | null;
  finalDescription: string | null;
  price: string | null;
  categoryId: string | null;
  condition: string | null;
  compNotes: string | null;
};

export default function ReviewPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/items");
    setItems(await res.json());
  }

  useEffect(() => {
    // Initial data load on mount, not a reaction to state we own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function updateItem(id: string, data: Partial<Item>) {
    setItems(
      (prev) =>
        prev?.map((i) => (i.id === id ? { ...i, ...data } : i)) ?? prev
    );
    await fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  }

  async function markReady(item: Item) {
    if (!item.finalTitle?.trim() || !item.price) {
      setError(`"${item.upc}" needs a title and price before it can go ready.`);
      return;
    }
    setError(null);
    await updateItem(item.id, { status: "ready" });
  }

  async function exportReady() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Export failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ebay-export.csv";
      a.click();
      URL.revokeObjectURL(url);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setExporting(false);
    }
  }

  if (!items) return <main className="p-6">Loading…</main>;

  const pending = items.filter((i) => i.status === "pending_review");
  const ready = items.filter((i) => i.status === "ready");
  const exported = items.filter((i) => i.status === "exported");

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Review Queue</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">
            {ready.length} ready to export
          </span>
          <button
            type="button"
            onClick={exportReady}
            disabled={exporting || ready.length === 0}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {exporting ? "Exporting…" : "Download CSV for eBay"}
          </button>
        </div>
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <h2 className="mb-2 text-sm font-medium text-gray-500">
        Pending review ({pending.length})
      </h2>
      <div className="mb-8 flex flex-col gap-3">
        {pending.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            onChange={(data) => updateItem(item.id, data)}
            onMarkReady={() => markReady(item)}
          />
        ))}
        {pending.length === 0 && (
          <p className="text-sm text-gray-400">Nothing waiting on review.</p>
        )}
      </div>

      <h2 className="mb-2 text-sm font-medium text-gray-500">
        Ready to list ({ready.length})
      </h2>
      <div className="mb-8 flex flex-col gap-2">
        {ready.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-3 rounded border p-3 text-sm"
          >
            {item.photoUrls[0] && (
              <img
                src={item.photoUrls[0]}
                alt=""
                className="h-10 w-10 rounded object-cover"
              />
            )}
            <span className="flex-1">{item.finalTitle}</span>
            <span className="text-gray-500">${item.price}</span>
          </div>
        ))}
      </div>

      {exported.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-medium text-gray-500">
            Exported ({exported.length})
          </h2>
          <div className="flex flex-col gap-2">
            {exported.map((item) => (
              <div key={item.id} className="text-sm text-gray-400">
                {item.finalTitle} — SKU {item.sku}
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function ItemCard({
  item,
  onChange,
  onMarkReady,
}: {
  item: Item;
  onChange: (data: Partial<Item>) => void;
  onMarkReady: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded border p-4 md:flex-row">
      <div className="flex gap-2 md:w-40 md:flex-col">
        {item.photoUrls.map((url) => (
          <img
            key={url}
            src={url}
            alt=""
            className="h-20 w-20 rounded object-cover"
          />
        ))}
      </div>

      <div className="flex-1">
        <div className="mb-2 flex flex-wrap gap-3 text-xs text-gray-500">
          <span>UPC {item.upc}</span>
          <span>Qty {item.quantity}</span>
          {item.isMultipack && <span>Pack of {item.packSize}</span>}
          <span>Shelf {item.shelfLocation}</span>
          {item.expirationDate && (
            <span>
              Exp {new Date(item.expirationDate).toLocaleDateString()}
            </span>
          )}
        </div>

        <input
          type="text"
          placeholder="Title (AI drafting coming soon — enter manually for now)"
          defaultValue={item.finalTitle ?? ""}
          onBlur={(e) => onChange({ finalTitle: e.target.value })}
          className="mb-2 w-full rounded border px-3 py-2 text-sm"
        />
        <textarea
          placeholder="Description"
          defaultValue={item.finalDescription ?? ""}
          onBlur={(e) => onChange({ finalDescription: e.target.value })}
          rows={2}
          className="mb-2 w-full rounded border px-3 py-2 text-sm"
        />

        <div className="flex flex-wrap gap-2">
          <input
            type="number"
            step="0.01"
            placeholder="Price"
            defaultValue={item.price ?? ""}
            onBlur={(e) => onChange({ price: e.target.value })}
            className="w-24 rounded border px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Category ID"
            defaultValue={item.categoryId ?? ""}
            onBlur={(e) => onChange({ categoryId: e.target.value })}
            className="w-32 rounded border px-3 py-2 text-sm"
          />
          <select
            defaultValue={item.condition ?? ""}
            onChange={(e) => onChange({ condition: e.target.value || null })}
            className="rounded border px-3 py-2 text-sm"
          >
            <option value="">Condition…</option>
            <option value="new">New</option>
            <option value="new_other">New (other)</option>
            <option value="used">Used</option>
            <option value="for_parts">For parts</option>
          </select>
          <input
            type="text"
            placeholder="Sold comps (paste from Terapeak)"
            defaultValue={item.compNotes ?? ""}
            onBlur={(e) => onChange({ compNotes: e.target.value })}
            className="min-w-48 flex-1 rounded border px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="flex md:flex-col md:justify-start">
        <button
          type="button"
          onClick={onMarkReady}
          className="h-fit rounded bg-black px-4 py-2 text-sm text-white"
        >
          Mark ready
        </button>
      </div>
    </div>
  );
}
