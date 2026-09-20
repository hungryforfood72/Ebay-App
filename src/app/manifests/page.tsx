"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { UserNavLinks } from "@/components/UserNav";

type Manifest = {
  id: string;
  title: string;
  supplier: string;
  totalLandedCost?: string | null;
  createdAt: string;
  _count: { lines: number; items: number };
};

const SUPPLIER_LABELS: Record<string, string> = {
  bstock: "BStock",
  liquidation_com: "Liquidation.com",
  unknown: "Unknown",
};

export default function ManifestsPage() {
  const [manifests, setManifests] = useState<Manifest[] | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    fetch("/api/manifests")
      .then((r) => r.json())
      .then(setManifests);
  }

  useEffect(load, []);

  async function handleFile(file: File) {
    setError(null);
    const csvContent = await file.text();

    // Detected supplier prefills a reasonable title, but only if the user
    // hasn't already typed their own.
    let prefill = title.trim();
    if (!prefill) {
      const supplierGuess = /Pallet ID/.test(csvContent) ? "BStock" : /Total Retail Price/.test(csvContent) ? "Liquidation.com" : null;
      prefill = supplierGuess ? `${supplierGuess} — ${new Date().toLocaleDateString()}` : file.name.replace(/\.csv$/i, "");
    }

    setUploading(true);
    try {
      const res = await fetch("/api/manifests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: prefill, csvContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      setTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Manifests</h1>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm underline">
            Dashboard
          </Link>
          <Link href="/scan" className="text-sm underline">
            Scan
          </Link>
          <Link href="/review" className="text-sm underline">
            Review
          </Link>
          <Link href="/analyzer" className="text-sm underline">
            Analyzer
          </Link>
          <UserNavLinks />
        </div>
      </div>

      <section className="mb-8 flex flex-col gap-2 rounded-lg border p-4">
        <label className="text-sm font-medium">Upload a new manifest</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional — auto-filled from the file if left blank)"
          className="rounded border px-3 py-2 text-sm"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
          disabled={uploading}
          className="cursor-pointer text-sm file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-black file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-gray-800 disabled:cursor-not-allowed"
        />
        {uploading && <p className="text-sm text-gray-500">Parsing…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <p className="text-xs text-gray-400">Supports BStock and Liquidation.com CSV exports — the format is detected automatically.</p>
      </section>

      {manifests === null && <p className="text-sm text-gray-500">Loading…</p>}

      {manifests && manifests.length === 0 && (
        <p className="text-sm text-gray-500">No manifests uploaded yet.</p>
      )}

      {manifests && manifests.length > 0 && (
        <ul className="flex flex-col gap-2">
          {manifests.map((m) => (
            <li key={m.id}>
              <Link
                href={`/manifests/${m.id}`}
                className="flex items-center justify-between rounded-lg border p-4 hover:bg-gray-50"
              >
                <div>
                  <p className="font-medium">{m.title}</p>
                  <p className="text-xs text-gray-500">
                    {SUPPLIER_LABELS[m.supplier] ?? m.supplier} · {m._count.lines} line items ·{" "}
                    {m._count.items} scanned in · {new Date(m.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {m.totalLandedCost && (
                  <span className="text-sm text-gray-500">${Number(m.totalLandedCost).toFixed(2)}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
