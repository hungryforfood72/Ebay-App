"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { UserNavLinks } from "@/components/UserNav";

type Candidate = {
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

// Separate from /manifests on purpose — that page is for loads Cristian has
// already bought and is receiving/reconciling. This is for manifests he's
// still deciding on: upload the CSV, run the sourcing agent, and either
// pass (never touch it again) or mark it purchased, which graduates the
// same record into the real Manifests list (see purchased on Manifest in
// prisma/schema.prisma).
export default function AnalyzerPage() {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    fetch("/api/manifests?purchased=false")
      .then((r) => r.json())
      .then(setCandidates);
  }

  useEffect(load, []);

  async function handleFile(file: File) {
    setError(null);
    const csvContent = await file.text();

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
        body: JSON.stringify({ title: prefill, csvContent, purchased: false }),
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
        <h1 className="text-xl font-semibold">Analyzer</h1>
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm underline">
            Dashboard
          </Link>
          <Link href="/manifests" className="text-sm underline">
            Manifests
          </Link>
          <Link href="/scan" className="text-sm underline">
            Scan
          </Link>
          <Link href="/review" className="text-sm underline">
            Review
          </Link>
          <UserNavLinks />
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-500">
        Upload a manifest you&apos;re considering buying to get a Buy/Don&apos;t-Buy call and a max bid
        before you commit — separate from Manifests, which is for loads you&apos;ve already bought.
      </p>

      <section className="mb-8 flex flex-col gap-2 rounded-lg border p-4">
        <label className="text-sm font-medium">Upload a manifest to evaluate</label>
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

      {candidates === null && <p className="text-sm text-gray-500">Loading…</p>}

      {candidates && candidates.length === 0 && (
        <p className="text-sm text-gray-500">Nothing uploaded to evaluate yet.</p>
      )}

      {candidates && candidates.length > 0 && (
        <ul className="flex flex-col gap-2">
          {candidates.map((c) => (
            <li key={c.id}>
              <Link
                href={`/analyzer/${c.id}`}
                className="flex items-center justify-between rounded-lg border p-4 hover:bg-gray-50"
              >
                <div>
                  <p className="font-medium">{c.title}</p>
                  <p className="text-xs text-gray-500">
                    {SUPPLIER_LABELS[c.supplier] ?? c.supplier} · {c._count.lines} line items ·{" "}
                    {new Date(c.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
