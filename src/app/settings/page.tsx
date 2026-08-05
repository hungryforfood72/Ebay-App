"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type BoxSize = {
  id: string;
  label: string;
};

export default function SettingsPage() {
  const [boxSizes, setBoxSizes] = useState<BoxSize[] | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/box-sizes");
    setBoxSizes(await res.json());
  }

  useEffect(() => {
    // Initial data load on mount, not a reaction to state we own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function addBoxSize() {
    const label = newLabel.trim();
    if (!label) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/box-sizes", {
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

  async function removeBoxSize(id: string) {
    setBoxSizes((prev) => prev?.filter((b) => b.id !== id) ?? prev);
    await fetch(`/api/box-sizes/${id}`, { method: "DELETE" });
  }

  return (
    <main className="mx-auto max-w-lg p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        <Link href="/review" className="text-sm underline">
          Back to review
        </Link>
      </div>

      <h2 className="mb-2 text-sm font-medium text-gray-500">Box sizes</h2>
      <p className="mb-3 text-xs text-gray-400">
        These show up as a dropdown on the review page&apos;s Box Size field.
      </p>

      <div className="mb-4 flex gap-2">
        <input
          type="text"
          placeholder="e.g. Small 6x4x2"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addBoxSize()}
          className="flex-1 rounded border px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={addBoxSize}
          disabled={saving || !newLabel.trim()}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {!boxSizes ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : boxSizes.length === 0 ? (
        <p className="text-sm text-gray-400">No box sizes yet — add one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {boxSizes.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between rounded border px-3 py-2 text-sm"
            >
              {b.label}
              <button
                type="button"
                onClick={() => removeBoxSize(b.id)}
                className="text-xs text-red-600"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
