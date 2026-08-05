"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type LabeledEntry = {
  id: string;
  label: string;
};

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-lg p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        <div className="flex items-center gap-3">
          <Link href="/scan" className="text-sm underline">
            Scan
          </Link>
          <Link href="/review" className="text-sm underline">
            Review
          </Link>
        </div>
      </div>

      <LabelListEditor
        apiPath="/api/box-sizes"
        title="Box sizes"
        description="These show up as a dropdown on the scan and review pages' Box Size field."
        placeholder="e.g. Small 6x4x2"
      />

      <ShelfLocationsEditor />
    </main>
  );
}

function LabelListEditor({
  apiPath,
  title,
  description,
  placeholder,
}: {
  apiPath: string;
  title: string;
  description: string;
  placeholder: string;
}) {
  const [entries, setEntries] = useState<LabeledEntry[] | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch(apiPath);
    setEntries(await res.json());
  }

  useEffect(() => {
    // Initial data load on mount, not a reaction to state we own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addEntry() {
    const label = newLabel.trim();
    if (!label) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to add.");
      }
      setNewLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  async function removeEntry(id: string) {
    setEntries((prev) => prev?.filter((b) => b.id !== id) ?? prev);
    await fetch(`${apiPath}/${id}`, { method: "DELETE" });
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-medium text-gray-500">{title}</h2>
      <p className="mb-3 text-xs text-gray-400">{description}</p>

      <div className="mb-4 flex gap-2">
        <input
          type="text"
          placeholder={placeholder}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addEntry()}
          className="flex-1 rounded border px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={addEntry}
          disabled={saving || !newLabel.trim()}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {!entries ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-gray-400">Nothing yet — add one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between rounded border px-3 py-2 text-sm"
            >
              {entry.label}
              <button
                type="button"
                onClick={() => removeEntry(entry.id)}
                className="text-xs text-red-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Shelf locations get their own editor (rather than reusing LabelListEditor)
// because they also support adding a whole range at once (e.g. "A1-A50")
// and printing scannable barcode labels for a range — neither applies to
// box sizes.
function ShelfLocationsEditor() {
  const [entries, setEntries] = useState<LabeledEntry[] | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [bulkRange, setBulkRange] = useState("");
  const [printRange, setPrintRange] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/shelf-locations");
    setEntries(await res.json());
  }

  useEffect(() => {
    // Initial data load on mount, not a reaction to state we own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function addEntry() {
    const label = newLabel.trim();
    if (!label) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/shelf-locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to add.");
      }
      setNewLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  async function addRange() {
    const range = bulkRange.trim();
    if (!range) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/shelf-locations/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ range }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to add range.");
      }
      setBulkRange("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  async function removeEntry(id: string) {
    setEntries((prev) => prev?.filter((b) => b.id !== id) ?? prev);
    await fetch(`/api/shelf-locations/${id}`, { method: "DELETE" });
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-medium text-gray-500">Shelf locations</h2>
      <p className="mb-3 text-xs text-gray-400">
        These show up as a dropdown on the scan page&apos;s Location field — and can be
        picked by scanning a printed barcode label instead of scrolling the list.
      </p>

      <div className="mb-2 flex gap-2">
        <input
          type="text"
          placeholder="e.g. A6"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addEntry()}
          className="flex-1 rounded border px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={addEntry}
          disabled={saving || !newLabel.trim()}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          Add
        </button>
      </div>

      <div className="mb-4 flex gap-2">
        <input
          type="text"
          placeholder="Add a range, e.g. A1-A50"
          value={bulkRange}
          onChange={(e) => setBulkRange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addRange()}
          className="flex-1 rounded border px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={addRange}
          disabled={saving || !bulkRange.trim()}
          className="rounded border px-4 py-2 text-sm disabled:opacity-40"
        >
          Add range
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <div className="mb-1 flex items-end gap-2 rounded border p-3">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-gray-500">
            Print barcode labels
          </label>
          <input
            type="text"
            placeholder="Blank = all locations, or a range like A25-A40"
            value={printRange}
            onChange={(e) => setPrintRange(e.target.value)}
            className="w-full rounded border px-3 py-2 text-sm"
          />
        </div>
        <a
          href={`/settings/labels${printRange.trim() ? `?range=${encodeURIComponent(printRange.trim())}` : ""}`}
          target="_blank"
          rel="noreferrer"
          className="rounded bg-black px-4 py-2 text-sm text-white"
        >
          Print
        </a>
      </div>
      <p className="mb-4 text-xs text-gray-400">
        1&quot; x 2&quot; labels — one per location, each with a scannable barcode.
      </p>

      {!entries ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-gray-400">Nothing yet — add one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between rounded border px-3 py-2 text-sm"
            >
              {entry.label}
              <button
                type="button"
                onClick={() => removeEntry(entry.id)}
                className="text-xs text-red-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
