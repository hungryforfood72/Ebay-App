"use client";

import { Stat } from "@/components/Stat";
import Link from "next/link";
import { useEffect, useState } from "react";

type ExpiringListedItem = {
  id: string;
  finalTitle: string | null;
  sku: string;
  expirationDate: string;
  price: number | null;
  shelfLocation: string;
  ebayAdId: string | null;
  promotedBidPercentage: number | null;
  ebayPublishError: string | null;
  ebayPromoteError: string | null;
};

type ExpiringUnlistedItem = {
  id: string;
  finalTitle: string | null;
  sku: string;
  expirationDate: string;
  status: string;
};

type DashboardData = {
  stats: {
    pendingReview: number;
    readyToPublish: number;
    listed: number;
    expiringCount: number;
    soldThisMonthRevenue: number;
    soldThisMonthUnits: number;
  };
  ebay: { connected: boolean; missingScopes: string[] };
  expiringListed: ExpiringListedItem[];
  expiringUnlisted: ExpiringUnlistedItem[];
};

function shortScopeName(scope: string): string {
  return scope.split("/").pop() ?? scope;
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);

  function load() {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then(setData);
  }

  useEffect(load, []);

  function updateItem(id: string, patch: Partial<ExpiringListedItem>) {
    setData((prev) =>
      prev
        ? { ...prev, expiringListed: prev.expiringListed.map((i) => (i.id === id ? { ...i, ...patch } : i)) }
        : prev
    );
  }

  if (!data) return <main className="p-6">Loading…</main>;

  const { stats, ebay, expiringListed, expiringUnlisted } = data;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="flex items-center gap-3">
          <Link href="/scan" className="text-sm underline">
            Scan
          </Link>
          <Link href="/review" className="text-sm underline">
            Review
          </Link>
          <Link href="/manifests" className="text-sm underline">
            Manifests
          </Link>
          <Link href="/settings" className="text-sm underline">
            Settings
          </Link>
        </div>
      </div>
      <p className="mb-6 text-sm text-gray-500">Sticker Peak eBay tool — overview</p>

      {(!ebay.connected || ebay.missingScopes.length > 0) && (
        <section className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {!ebay.connected ? (
            <p>
              eBay isn&apos;t connected —{" "}
              <Link href="/settings" className="underline">
                connect it in Settings
              </Link>{" "}
              to publish, sync sales, or promote listings.
            </p>
          ) : (
            <p>
              eBay reconnect required — missing: {ebay.missingScopes.map(shortScopeName).join(", ")}.{" "}
              <Link href="/settings" className="underline">
                Reconnect in Settings
              </Link>
              .
            </p>
          )}
        </section>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3">
        <Link href="/scan" className="rounded-lg bg-black px-4 py-3 text-center text-white">
          Scan items
        </Link>
        <Link href="/review" className="rounded-lg border-2 border-black px-4 py-3 text-center font-medium">
          Review queue
        </Link>
      </div>

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Pending review" value={stats.pendingReview} />
        <Stat label="Ready to publish" value={stats.readyToPublish} />
        <Stat label="Listed" value={stats.listed} />
        <Stat label="Expiring ≤21 days" value={stats.expiringCount} highlight={stats.expiringCount > 0} />
        <Stat label="Sold this month" value={stats.soldThisMonthRevenue} format="currency" />
        <Stat label="Units sold this month" value={stats.soldThisMonthUnits} />
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-gray-500">
          Expiring soon — listed ({expiringListed.length})
        </h2>
        {expiringListed.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing listed is expiring in the next 21 days.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {expiringListed.map((item) => (
              <ExpiringItemCard key={item.id} item={item} onChange={(patch) => updateItem(item.id, patch)} />
            ))}
          </div>
        )}
      </section>

      {expiringUnlisted.length > 0 && (
        <section className="mb-6 rounded-lg border border-orange-300 bg-orange-50 p-4">
          <h2 className="mb-2 text-sm font-medium">
            Expiring soon — not yet published ({expiringUnlisted.length})
          </h2>
          <p className="mb-2 text-xs text-gray-500">
            These have no live eBay listing yet, so they can&apos;t be discounted or promoted — get them
            published before they expire.
          </p>
          <div className="flex flex-col gap-1">
            {expiringUnlisted.map((item) => (
              <div key={item.id} className="flex items-center justify-between text-sm">
                <span>{item.finalTitle ?? item.sku}</span>
                <span className={daysUntil(item.expirationDate) <= 7 ? "font-semibold text-red-600" : "text-gray-500"}>
                  {new Date(item.expirationDate).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
          <Link href="/review" className="mt-2 inline-block text-sm underline">
            Go to review queue
          </Link>
        </section>
      )}
    </main>
  );
}

function ExpiringItemCard({
  item,
  onChange,
}: {
  item: ExpiringListedItem;
  onChange: (patch: Partial<ExpiringListedItem>) => void;
}) {
  const [discountMode, setDiscountMode] = useState<"percent" | "amount">("percent");
  const [discountValue, setDiscountValue] = useState("");
  const [bidPercentage, setBidPercentage] = useState("");
  const [acting, setActing] = useState<"discount" | "promote" | "bid" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = daysUntil(item.expirationDate);
  const urgent = days <= 7;

  async function applyDiscount() {
    const value = Number(discountValue);
    if (!value || value <= 0) return;
    const label = discountMode === "percent" ? `${value}% off` : `$${value.toFixed(2)} off`;
    if (!confirm(`Apply ${label} to "${item.finalTitle ?? item.sku}"? This changes the real live eBay price.`)) {
      return;
    }
    setActing("discount");
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/discount`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: discountMode, value }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Discount failed.");
      onChange({ price: Number(result.price) });
      setDiscountValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setActing(null);
    }
  }

  async function promote() {
    const value = Number(bidPercentage);
    if (!value || value < 1 || value > 100) return;
    if (
      !confirm(
        `Promote "${item.finalTitle ?? item.sku}" at ${value}% bid? eBay charges this as a fee on the sale price if it sells while promoted.`
      )
    ) {
      return;
    }
    setActing("promote");
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bidPercentage: value }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Promote failed.");
      onChange({ ebayAdId: result.ebayAdId, promotedBidPercentage: result.promotedBidPercentage });
      setBidPercentage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setActing(null);
    }
  }

  async function updateBid() {
    const value = Number(bidPercentage);
    if (!value || value < 1 || value > 100) return;
    setActing("bid");
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/promote`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bidPercentage: value }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Bid update failed.");
      onChange({ promotedBidPercentage: result.promotedBidPercentage });
      setBidPercentage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setActing(null);
    }
  }

  async function stopPromoting() {
    if (!confirm(`Stop promoting "${item.finalTitle ?? item.sku}"? The listing stays live, just not advertised.`)) {
      return;
    }
    setActing("stop");
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/promote`, { method: "DELETE" });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Failed to stop promoting.");
      onChange({ ebayAdId: null, promotedBidPercentage: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{item.finalTitle ?? item.sku}</p>
          <p className="text-xs text-gray-400">
            {item.shelfLocation} · {item.price != null ? `$${item.price.toFixed(2)}` : "no price"}
          </p>
        </div>
        <span className={`text-sm ${urgent ? "font-semibold text-red-600" : "text-gray-500"}`}>
          {days < 0 ? "Expired" : `${days}d left`} · {new Date(item.expirationDate).toLocaleDateString()}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={discountMode}
          onChange={(e) => setDiscountMode(e.target.value as "percent" | "amount")}
          className="rounded border px-2 py-1.5 text-xs"
        >
          <option value="percent">% off</option>
          <option value="amount">$ off</option>
        </select>
        <input
          type="number"
          step="0.01"
          min={0}
          value={discountValue}
          onChange={(e) => setDiscountValue(e.target.value)}
          placeholder={discountMode === "percent" ? "15" : "5.00"}
          className="w-20 rounded border px-2 py-1.5 text-xs"
        />
        <button
          type="button"
          onClick={applyDiscount}
          disabled={acting !== null || !discountValue}
          className="rounded bg-black px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {acting === "discount" ? "Applying…" : "Discount"}
        </button>

        {item.ebayAdId ? (
          <>
            <span className="rounded-full bg-green-100 px-2 py-1 text-xs text-green-700">
              Promoted at {item.promotedBidPercentage}%
            </span>
            <input
              type="number"
              min={1}
              max={100}
              value={bidPercentage}
              onChange={(e) => setBidPercentage(e.target.value)}
              placeholder="new %"
              className="w-16 rounded border px-2 py-1.5 text-xs"
            />
            <button
              type="button"
              onClick={updateBid}
              disabled={acting !== null || !bidPercentage}
              className="rounded border px-3 py-1.5 text-xs disabled:opacity-40"
            >
              {acting === "bid" ? "Updating…" : "Update bid"}
            </button>
            <button
              type="button"
              onClick={stopPromoting}
              disabled={acting !== null}
              className="rounded border border-red-300 px-3 py-1.5 text-xs text-red-600 disabled:opacity-40"
            >
              {acting === "stop" ? "Stopping…" : "Stop promoting"}
            </button>
          </>
        ) : (
          <>
            <input
              type="number"
              min={1}
              max={100}
              value={bidPercentage}
              onChange={(e) => setBidPercentage(e.target.value)}
              placeholder="bid %"
              className="w-16 rounded border px-2 py-1.5 text-xs"
            />
            <button
              type="button"
              onClick={promote}
              disabled={acting !== null || !bidPercentage}
              className="rounded border px-3 py-1.5 text-xs disabled:opacity-40"
            >
              {acting === "promote" ? "Promoting…" : "Promote"}
            </button>
          </>
        )}
      </div>

      {(error || item.ebayPromoteError) && (
        <p className="mt-2 text-xs text-red-600">{error ?? item.ebayPromoteError}</p>
      )}
    </div>
  );
}
