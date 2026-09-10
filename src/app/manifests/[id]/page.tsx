"use client";

import Link from "next/link";
import { useEffect, useState, use as usePromise } from "react";

type Line = {
  id: string;
  supplierSku: string | null;
  upc: string | null;
  description: string;
  expectedQuantity: number;
  retailPrice: number;
  extendedRetail: number;
  condition: string | null;
  category: string | null;
  subcategory: string | null;
  receivedUnits: number;
  damagedUnits: number;
  accountedUnits: number;
  missingUnits: number;
  weightedCogsPerUnit: number | null;
};

type ManifestDetail = {
  id: string;
  title: string;
  supplier: string;
  totalLandedCost: number | null;
  createdAt: string;
  lines: Line[];
  unmatchedReceived: { upc: string | null; units: number }[];
  unmatchedDamaged: { upc: string | null; units: number }[];
  summary: {
    totalExpectedUnits: number;
    totalReceivedUnits: number;
    totalDamagedUnits: number;
    totalAccountedUnits: number;
    totalMissingUnits: number;
    totalManifestExtendedRetail: number;
    blendedCogsPerUnit: number | null;
  };
};

export default function ManifestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const [manifest, setManifest] = useState<ManifestDetail | null>(null);
  const [landedCostInput, setLandedCostInput] = useState("");
  const [savingCost, setSavingCost] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetch(`/api/manifests/${id}`)
      .then((r) => r.json())
      .then((data: ManifestDetail) => {
        setManifest(data);
        setLandedCostInput(data.totalLandedCost != null ? String(data.totalLandedCost) : "");
      });
  }

  useEffect(load, [id]);

  async function saveLandedCost() {
    setSavingCost(true);
    setError(null);
    try {
      const res = await fetch(`/api/manifests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalLandedCost: landedCostInput || null }),
      });
      if (!res.ok) throw new Error("Failed to save.");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSavingCost(false);
    }
  }

  if (!manifest) return <main className="p-6">Loading…</main>;

  const s = manifest.summary;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{manifest.title}</h1>
        <div className="flex items-center gap-3">
          <Link href="/manifests" className="text-sm underline">
            All manifests
          </Link>
          <Link href="/review" className="text-sm underline">
            Review
          </Link>
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-500">
        {new Date(manifest.createdAt).toLocaleDateString()} · {manifest.lines.length} line items
      </p>

      <Link
        href={`/scan?manifestId=${manifest.id}`}
        className="mb-6 inline-block rounded-lg bg-black px-4 py-3 text-center text-white"
      >
        Scan into this manifest
      </Link>

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Expected units" value={s.totalExpectedUnits} />
        <Stat label="Received" value={s.totalReceivedUnits} />
        <Stat label="Damaged/expired" value={s.totalDamagedUnits} />
        <Stat
          label="Missing"
          value={s.totalMissingUnits}
          highlight={s.totalMissingUnits !== 0}
        />
      </section>

      <section className="mb-6 flex flex-col gap-2 rounded-lg border p-4">
        <label className="text-sm font-medium">Total landed cost for this load</label>
        <div className="flex gap-2">
          <input
            type="number"
            step="0.01"
            value={landedCostInput}
            onChange={(e) => setLandedCostInput(e.target.value)}
            placeholder="e.g. 1200.00"
            className="flex-1 rounded border px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={saveLandedCost}
            disabled={savingCost}
            className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
          >
            Save
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {s.blendedCogsPerUnit != null ? (
          <p className="text-sm text-gray-600">
            Blended COGS: <strong>${s.blendedCogsPerUnit.toFixed(4)}</strong> per unit (landed cost ÷{" "}
            {s.totalReceivedUnits} units received). Per-line weighted cost below accounts for each
            item&apos;s share of the load&apos;s declared value, divided by that line&apos;s good units
            received — damaged/expired and still-missing units aren&apos;t counted.
          </p>
        ) : (
          <p className="text-xs text-gray-400">Enter a landed cost to see COGS per unit.</p>
        )}
      </section>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="py-2 pr-2">Item</th>
              <th className="px-2 text-right">Expected</th>
              <th className="px-2 text-right">Received</th>
              <th className="px-2 text-right">Damaged</th>
              <th className="px-2 text-right">Missing</th>
              <th className="px-2 text-right">Weighted COGS/unit</th>
            </tr>
          </thead>
          <tbody>
            {manifest.lines.map((line) => (
              <tr key={line.id} className="border-b">
                <td className="py-2 pr-2">
                  <p className="font-medium">{line.description}</p>
                  <p className="text-xs text-gray-400">
                    {line.upc ?? "no UPC"} · ${line.retailPrice.toFixed(2)} retail
                  </p>
                </td>
                <td className="px-2 text-right">{line.expectedQuantity}</td>
                <td className="px-2 text-right">{line.receivedUnits}</td>
                <td className="px-2 text-right">{line.damagedUnits}</td>
                <td className={`px-2 text-right ${line.missingUnits !== 0 ? "font-semibold text-red-600" : ""}`}>
                  {line.missingUnits}
                </td>
                <td className="px-2 text-right">
                  {line.weightedCogsPerUnit != null ? `$${line.weightedCogsPerUnit.toFixed(4)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(manifest.unmatchedReceived.length > 0 || manifest.unmatchedDamaged.length > 0) && (
        <section className="mt-6 rounded-lg border border-orange-300 bg-orange-50 p-4 text-sm">
          <p className="mb-2 font-medium">Scanned items not on this manifest</p>
          {manifest.unmatchedReceived.map((u) => (
            <p key={`r-${u.upc}`}>Received {u.units} unit(s) of UPC {u.upc ?? "(none)"} — not on the manifest.</p>
          ))}
          {manifest.unmatchedDamaged.map((u) => (
            <p key={`d-${u.upc}`}>Marked {u.units} unit(s) damaged for UPC {u.upc} — not on the manifest.</p>
          ))}
        </section>
      )}
    </main>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold ${highlight ? "text-red-600" : ""}`}>{value}</p>
    </div>
  );
}
