"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { UserNavLinks } from "@/components/UserNav";

type LabeledEntry = {
  id: string;
  label: string;
};

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  return (
    <main className="mx-auto max-w-lg p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
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
          <UserNavLinks showSettings={false} />
        </div>
      </div>

      <EbayConnectionStatus />

      <LabelListEditor
        apiPath="/api/box-sizes"
        title="Box sizes"
        description="These show up as a dropdown on the scan and review pages' Box Size field."
        placeholder="e.g. Small 6x4x2"
      />

      <ShelfLocationsEditor />

      <SourcingMarginSetting />

      <MaxMonthsToSellThroughSetting />

      <WalkupSaleMarginSettings />

      <ExpirationBufferSetting />

      <UsersManager />
    </main>
  );
}

type AppUser = { id: string; username: string; role: "owner" | "employee"; createdAt: string };

// Owner-only (this whole page is — proxy.ts blocks /settings entirely for
// employees). Employees get their own accounts here so stock/scan changes
// can be attributed to a real person and financial data can stay hidden
// from their view — see the role check baked into each relevant API route
// (dashboard, manifests, inventory), not anything client-side here.
function UsersManager() {
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"employee" | "owner">("employee");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetch("/api/users")
      .then((r) => r.json())
      .then((data: { users: AppUser[] }) => setUsers(data.users));
  }

  useEffect(load, []);

  async function addUser() {
    if (!newUsername.trim() || !newPassword) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole }),
      });
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        throw new Error(result.error ?? "Failed to create user.");
      }
      setNewUsername("");
      setNewPassword("");
      setNewRole("employee");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  async function removeUser(user: AppUser) {
    if (!confirm(`Remove "${user.username}"? They'll be signed out immediately.`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        throw new Error(result.error ?? "Failed to remove user.");
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-medium text-gray-500">Users</h2>
      <p className="mb-3 text-xs text-gray-400">
        Employee accounts see no financial numbers anywhere in the app (profit, COGS, revenue, sourcing
        agent bid decisions), and can&apos;t delete records or reach this Settings page.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Username"
          value={newUsername}
          onChange={(e) => setNewUsername(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        />
        <input
          type="password"
          placeholder="Password (min. 8 characters)"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        />
        <select
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as "employee" | "owner")}
          className="rounded border px-3 py-2 text-sm"
        >
          <option value="employee">Employee</option>
          <option value="owner">Owner</option>
        </select>
        <button
          type="button"
          onClick={addUser}
          disabled={saving || !newUsername.trim() || !newPassword}
          className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          Add user
        </button>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      {!users ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {users.map((user) => (
            <li key={user.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
              <span>
                {user.username}{" "}
                <span className="text-xs text-gray-400">
                  ({user.role}, since {new Date(user.createdAt).toLocaleDateString()})
                </span>
              </span>
              <button type="button" onClick={() => removeUser(user)} className="text-xs text-red-600">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Target profit margin the sourcing agent solves the max-bid formula
// against (maxBid = expected net contribution / (1 + margin)) — same
// simple fetch/save pattern as the manifest page's landed-cost input, no
// need for a generic settings component for one scalar value.
function SourcingMarginSetting() {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    fetch("/api/settings/sourcing-target-margin")
      .then((r) => r.json())
      .then((data: { targetMarginPct: number }) => setValue(String(data.targetMarginPct)));
  }

  useEffect(load, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/sourcing-target-margin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetMarginPct: Number(value) }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 rounded-lg border p-4">
      <label className="mb-1 block text-sm font-medium">Sourcing agent target margin</label>
      <p className="mb-2 text-xs text-gray-400">
        Used to solve for the max recommended bid on a manifest — higher means a more conservative
        (lower) suggested bid for the same expected profit.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="1"
          min={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          className="w-24 rounded border px-3 py-2 text-sm"
        />
        <span className="text-sm text-gray-500">%</span>
        <button
          type="button"
          onClick={save}
          disabled={saving || !value}
          className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-green-600">Saved</span>}
      </div>
    </section>
  );
}

// How many months of expected inventory at a line's recent sell rate
// counts as "too slow" and flags it — a good per-unit price doesn't mean
// much if the expected quantity would sit on the shelf for years. Same
// fetch/save pattern as SourcingMarginSetting above.
function MaxMonthsToSellThroughSetting() {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    fetch("/api/settings/sourcing-max-months-to-sell")
      .then((r) => r.json())
      .then((data: { maxMonthsToSellThrough: number }) => setValue(String(data.maxMonthsToSellThrough)));
  }

  useEffect(load, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/sourcing-max-months-to-sell", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxMonthsToSellThrough: Number(value) }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 rounded-lg border p-4">
      <label className="mb-1 block text-sm font-medium">Sourcing agent slow-mover threshold</label>
      <p className="mb-2 text-xs text-gray-400">
        A line gets flagged (and its profit contribution zeroed, same as any other dud) if its recent real sell
        rate says the expected quantity would take longer than this to sell through — even if the per-unit price
        looks good.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="1"
          min={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          className="w-24 rounded border px-3 py-2 text-sm"
        />
        <span className="text-sm text-gray-500">months</span>
        <button
          type="button"
          onClick={save}
          disabled={saving || !value}
          className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-green-600">Saved</span>}
      </div>
    </section>
  );
}

// Pricing for in-person walk-up sales (scan/page.tsx's "Walk-up sale" mode)
// — floor is a markup over that item's landed cost (protects real profit),
// ideal/near-expiry are a % of the manifest line's retail price (always
// present, and a much more realistic walk-up price than a thin cost
// markup — see src/lib/walkupSale.ts's own comment for why).
function WalkupSaleMarginSettings() {
  const [floorMarginPct, setFloorMarginPct] = useState("");
  const [idealRetailPct, setIdealRetailPct] = useState("");
  const [nearExpiryRetailPct, setNearExpiryRetailPct] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    fetch("/api/settings/walkup-sale-margins")
      .then((r) => r.json())
      .then((data: { floorMarginPct: number; idealRetailPct: number; nearExpiryRetailPct: number }) => {
        setFloorMarginPct(String(data.floorMarginPct));
        setIdealRetailPct(String(data.idealRetailPct));
        setNearExpiryRetailPct(String(data.nearExpiryRetailPct));
      });
  }

  useEffect(load, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/walkup-sale-margins", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          floorMarginPct: Number(floorMarginPct),
          idealRetailPct: Number(idealRetailPct),
          nearExpiryRetailPct: Number(nearExpiryRetailPct),
        }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 rounded-lg border p-4">
      <label className="mb-1 block text-sm font-medium">Walk-up sale pricing</label>
      <p className="mb-3 text-xs text-gray-400">
        Used by the Scan page&apos;s &quot;Walk-up sale&quot; mode for instant in-person pricing. Floor is a
        minimum-profit markup over what that item actually cost; the other two are a percentage of the
        item&apos;s retail price.
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="w-40 text-sm text-gray-600">Floor (min profit over cost)</span>
          <input
            type="number"
            step="1"
            min={1}
            value={floorMarginPct}
            onChange={(e) => {
              setFloorMarginPct(e.target.value);
              setSaved(false);
            }}
            className="w-24 rounded border px-3 py-2 text-sm"
          />
          <span className="text-sm text-gray-500">%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-40 text-sm text-gray-600">Ideal (% of retail)</span>
          <input
            type="number"
            step="1"
            min={1}
            value={idealRetailPct}
            onChange={(e) => {
              setIdealRetailPct(e.target.value);
              setSaved(false);
            }}
            className="w-24 rounded border px-3 py-2 text-sm"
          />
          <span className="text-sm text-gray-500">%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-40 text-sm text-gray-600">Near-expiry (% of retail)</span>
          <input
            type="number"
            step="1"
            min={1}
            value={nearExpiryRetailPct}
            onChange={(e) => {
              setNearExpiryRetailPct(e.target.value);
              setSaved(false);
            }}
            className="w-24 rounded border px-3 py-2 text-sm"
          />
          <span className="text-sm text-gray-500">%</span>
        </div>
        <div>
          <button
            type="button"
            onClick={save}
            disabled={saving || !floorMarginPct || !idealRetailPct || !nearExpiryRetailPct}
            className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && <span className="ml-2 text-xs text-green-600">Saved</span>}
        </div>
      </div>
    </section>
  );
}

type EbayStatus = {
  environment: "sandbox" | "production";
  connected: boolean;
  connectedAt: string | null;
  missingScopes: string[];
};

// Scopes come back as full URIs (".../oauth/api_scope/sell.fulfillment") —
// just the trailing name reads better in a short banner.
function shortScopeName(scope: string): string {
  return scope.split("/").pop() ?? scope;
}

// Connect/disconnect the eBay account used by the "Publish to eBay" button
// on the review page. Tokens are kept per environment (see EbayAuthToken),
// so which one this shows depends entirely on the server's EBAY_ENV — there's
// no environment picker here, just a status readout for whichever one is
// currently active.
function EbayConnectionStatus() {
  const searchParams = useSearchParams();
  const callbackResult = searchParams.get("ebay");
  const [status, setStatus] = useState<EbayStatus | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  function load() {
    fetch("/api/ebay/status")
      .then((r) => r.json())
      .then(setStatus);
  }

  useEffect(() => {
    load();
  }, []);

  async function disconnect() {
    if (!confirm("Disconnect this eBay account? You'll need to reconnect before publishing again.")) {
      return;
    }
    setDisconnecting(true);
    await fetch("/api/ebay/status", { method: "DELETE" });
    load();
    setDisconnecting(false);
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-medium text-gray-500">eBay account</h2>
      <p className="mb-3 text-xs text-gray-400">
        Connects the account used by the &quot;Publish to eBay&quot; button on the review page.
      </p>

      {callbackResult === "connected" && (
        <p className="mb-3 text-sm text-green-600">Connected.</p>
      )}
      {callbackResult === "declined" && (
        <p className="mb-3 text-sm text-gray-500">Connection declined.</p>
      )}
      {callbackResult === "error" && (
        <p className="mb-3 text-sm text-red-600">
          {searchParams.get("ebayMessage") ?? "Something went wrong connecting — try again."}
        </p>
      )}

      {!status ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="flex items-center justify-between rounded border px-3 py-2 text-sm">
          <div>
            <p>
              {status.connected ? "Connected" : "Not connected"}{" "}
              <span className="text-xs text-gray-400">({status.environment})</span>
            </p>
            {status.connected && status.connectedAt && (
              <p className="text-xs text-gray-400">
                Since {new Date(status.connectedAt).toLocaleString()}
              </p>
            )}
            {status.connected && status.missingScopes.length > 0 && (
              <p className="mt-1 text-xs text-amber-600">
                Reconnect required — missing: {status.missingScopes.map(shortScopeName).join(", ")}
              </p>
            )}
          </div>
          {status.connected && status.missingScopes.length === 0 ? (
            <button
              type="button"
              onClick={disconnect}
              disabled={disconnecting}
              className="rounded border border-red-300 px-3 py-1 text-xs text-red-600 disabled:opacity-40"
            >
              Disconnect
            </button>
          ) : (
            <a href="/api/ebay/connect" className="rounded bg-black px-3 py-1 text-xs text-white">
              {status.connected ? "Reconnect eBay account" : "Connect eBay account"}
            </a>
          )}
        </div>
      )}
    </section>
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

// How many days BEFORE an item's printed expiration date the daily sweep
// actually ends its eBay listing — eBay's food policy requires the item to
// be *delivered* before that date, not just for the listing to come down
// on it, so this needs to cover order processing + shipping transit time,
// not just be a same-day cutoff.
function ExpirationBufferSetting() {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    fetch("/api/settings/expiration-buffer")
      .then((r) => r.json())
      .then((data: { bufferDays: number }) => setValue(String(data.bufferDays)));
  }

  useEffect(load, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/expiration-buffer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bufferDays: Number(value) }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 rounded-lg border p-4">
      <label className="mb-1 block text-sm font-medium">Expiration removal buffer</label>
      <p className="mb-2 text-xs text-gray-400">
        The daily sweep ends a listing this many days <strong>before</strong> its printed expiration
        date — not on the date itself — so a sale made right before removal still has time to process
        and ship before the item actually expires. Applies to both the eBay removal and the
        &quot;needs shelf pull&quot; notification on the dashboard.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="1"
          min={0}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          className="w-24 rounded border px-3 py-2 text-sm"
        />
        <span className="text-sm text-gray-500">days before expiration</span>
        <button
          type="button"
          onClick={save}
          disabled={saving || !value}
          className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-green-600">Saved</span>}
      </div>
    </section>
  );
}
