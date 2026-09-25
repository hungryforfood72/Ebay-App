"use client";

import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Input";
import { Check, Printer, Trash2, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";

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
    <AppShell width="medium" title="Settings">
      <div className="flex flex-col gap-8">
        <SettingsGroup title="Connections">
          <EbayConnectionStatus />
        </SettingsGroup>

        <SettingsGroup title="Scanning">
          <LabelListEditor
            apiPath="/api/box-sizes"
            title="Box sizes"
            description="These show up as a dropdown on the scan and review pages' Box Size field."
            placeholder="e.g. Small 6x4x2"
          />
          <ShelfLocationsEditor />
        </SettingsGroup>

        <SettingsGroup title="Sourcing agent">
          <SourcingMarginSetting />
          <MaxMonthsToSellThroughSetting />
        </SettingsGroup>

        <SettingsGroup title="Pricing & listings">
          <WalkupSaleMarginSettings />
          <ExpirationBufferSetting />
        </SettingsGroup>

        <SettingsGroup title="Team">
          <UsersManager />
        </SettingsGroup>
      </div>
    </AppShell>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

// Number input with its unit shown inside the field ("%", "months", "days").
function SuffixInput({
  suffix,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type" | "size"> & { suffix: string }) {
  return (
    <div className="relative w-36">
      <Input type="number" {...props} className="pr-16" />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
        {suffix}
      </span>
    </div>
  );
}

function SaveButton({ onClick, disabled, saving, saved }: { onClick: () => void; disabled: boolean; saving: boolean; saved: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Button onClick={onClick} disabled={disabled}>
        {saving ? "Saving…" : "Save"}
      </Button>
      {saved && (
        <span className="inline-flex items-center gap-1 text-sm font-medium text-success">
          <Check className="size-4" aria-hidden />
          Saved
        </span>
      )}
    </div>
  );
}

// Chip list for short labels (box sizes, shelf locations) — a range like
// A1-A50 would otherwise be 50 full-width rows.
function LabelChips({ entries, onRemove }: { entries: LabeledEntry[]; onRemove: (id: string) => void }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-background py-1 pl-3 pr-1 text-sm text-foreground"
        >
          {entry.label}
          <button
            type="button"
            onClick={() => onRemove(entry.id)}
            aria-label={`Remove ${entry.label}`}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-danger"
          >
            <X className="size-4" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
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
    <Card>
      <SectionHeader
        title="Users"
        description="Employee accounts see no financial numbers anywhere in the app (profit, COGS, revenue, sourcing agent bid decisions), and can't delete records or reach this Settings page."
      />

      {!users ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="mb-5 divide-y divide-border rounded-lg border border-border">
          {users.map((user) => (
            <li key={user.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  {user.username}
                  <Badge tone={user.role === "owner" ? "primary" : "neutral"}>{user.role}</Badge>
                </p>
                <p className="text-xs text-muted-foreground">Since {new Date(user.createdAt).toLocaleDateString()}</p>
              </div>
              <Button variant="danger-ghost" size="sm" onClick={() => removeUser(user)}>
                <Trash2 className="size-4" aria-hidden />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="mb-3 text-sm font-medium text-foreground">Add a user</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem]">
        <Field label="Username">
          <Input type="text" autoCapitalize="off" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </Field>
        <Field label="Role">
          <Select value={newRole} onChange={(e) => setNewRole(e.target.value as "employee" | "owner")}>
            <option value="employee">Employee</option>
            <option value="owner">Owner</option>
          </Select>
        </Field>
      </div>
      <Button className="mt-1" onClick={addUser} disabled={saving || !newUsername.trim() || !newPassword}>
        {saving ? "Adding…" : "Add user"}
      </Button>
      {error && <p className="mt-3 text-sm font-medium text-danger">{error}</p>}
    </Card>
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
    <Card>
      <SectionHeader
        title="Target margin"
        description="Used to solve for the max recommended bid on a manifest — higher means a more conservative (lower) suggested bid for the same expected profit."
      />
      <div className="flex flex-wrap items-center gap-3">
        <SuffixInput
          suffix="%"
          step="1"
          min={1}
          value={value}
          aria-label="Target margin percent"
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
        />
        <SaveButton onClick={save} disabled={saving || !value} saving={saving} saved={saved} />
      </div>
    </Card>
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
    <Card>
      <SectionHeader
        title="Slow-mover threshold"
        description="A line gets flagged (and its profit contribution zeroed, same as any other dud) if its recent real sell rate says the expected quantity would take longer than this to sell through — even if the per-unit price looks good."
      />
      <div className="flex flex-wrap items-center gap-3">
        <SuffixInput
          suffix="months"
          step="1"
          min={1}
          value={value}
          aria-label="Slow-mover threshold in months"
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
        />
        <SaveButton onClick={save} disabled={saving || !value} saving={saving} saved={saved} />
      </div>
    </Card>
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

  const rows: { label: string; hint: string; value: string; set: (v: string) => void }[] = [
    { label: "Floor", hint: "Minimum profit over what the item cost", value: floorMarginPct, set: setFloorMarginPct },
    { label: "Ideal", hint: "Percent of retail price", value: idealRetailPct, set: setIdealRetailPct },
    { label: "Near-expiry", hint: "Percent of retail price", value: nearExpiryRetailPct, set: setNearExpiryRetailPct },
  ];

  return (
    <Card>
      <SectionHeader
        title="Walk-up sale pricing"
        description={`Instant in-person pricing for the Scan page's "Walk-up sale" and "Sell shelf item" modes.`}
      />
      <div className="mb-4 flex flex-col divide-y divide-border rounded-lg border border-border">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{row.label}</p>
              <p className="text-xs text-muted-foreground">{row.hint}</p>
            </div>
            <SuffixInput
              suffix="%"
              step="1"
              min={1}
              value={row.value}
              aria-label={`${row.label} percent`}
              onChange={(e) => {
                row.set(e.target.value);
                setSaved(false);
              }}
            />
          </div>
        ))}
      </div>
      <SaveButton
        onClick={save}
        disabled={saving || !floorMarginPct || !idealRetailPct || !nearExpiryRetailPct}
        saving={saving}
        saved={saved}
      />
    </Card>
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

  const needsReconnect = Boolean(status?.connected && status.missingScopes.length > 0);

  return (
    <Card>
      <SectionHeader
        title="eBay account"
        description='Connects the account used by the "Publish to eBay" button on the review page.'
      />

      {callbackResult === "connected" && <p className="mb-3 text-sm font-medium text-success">Connected.</p>}
      {callbackResult === "declined" && <p className="mb-3 text-sm text-muted-foreground">Connection declined.</p>}
      {callbackResult === "error" && (
        <p className="mb-3 text-sm font-medium text-danger">
          {searchParams.get("ebayMessage") ?? "Something went wrong connecting — try again."}
        </p>
      )}

      {!status ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <span
                className={
                  status.connected && !needsReconnect
                    ? "size-2.5 rounded-full bg-green-500"
                    : needsReconnect
                      ? "size-2.5 rounded-full bg-amber-500"
                      : "size-2.5 rounded-full bg-zinc-300"
                }
                aria-hidden
              />
              {status.connected ? "Connected" : "Not connected"}
              <Badge>{status.environment}</Badge>
            </p>
            {status.connected && status.connectedAt && (
              <p className="mt-0.5 text-xs text-muted-foreground">Since {new Date(status.connectedAt).toLocaleString()}</p>
            )}
            {needsReconnect && (
              <p className="mt-1 text-xs font-medium text-warning">
                Reconnect required — missing: {status.missingScopes.map(shortScopeName).join(", ")}
              </p>
            )}
          </div>
          {status.connected && status.missingScopes.length === 0 ? (
            <Button variant="danger-ghost" size="sm" onClick={disconnect} disabled={disconnecting}>
              Disconnect
            </Button>
          ) : (
            <a href="/api/ebay/connect" className={buttonClasses({ size: "sm" })}>
              {status.connected ? "Reconnect eBay account" : "Connect eBay account"}
            </a>
          )}
        </div>
      )}
    </Card>
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
    <Card>
      <SectionHeader
        title={title}
        description={description}
        action={entries && entries.length > 0 ? <Badge>{entries.length}</Badge> : undefined}
      />
      <div className="mb-4 flex gap-2">
        <Input
          size="sm"
          type="text"
          placeholder={placeholder}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addEntry()}
          aria-label={`New ${title.toLowerCase()}`}
          className="min-w-0"
        />
        <Button onClick={addEntry} disabled={saving || !newLabel.trim()} className="shrink-0">
          Add
        </Button>
      </div>
      {error && <p className="mb-3 text-sm font-medium text-danger">{error}</p>}
      {!entries ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet — add one above.</p>
      ) : (
        <LabelChips entries={entries} onRemove={removeEntry} />
      )}
    </Card>
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
    <Card>
      <SectionHeader
        title="Shelf locations"
        description="Suggested on the scan page's shelf location field — and can be entered by scanning a printed barcode label instead of typing."
        action={entries && entries.length > 0 ? <Badge>{entries.length}</Badge> : undefined}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label="Add one">
          <div className="flex gap-2">
            <Input
              size="sm"
              type="text"
              placeholder="e.g. A6"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addEntry()}
              className="min-w-0"
            />
            <Button onClick={addEntry} disabled={saving || !newLabel.trim()} className="shrink-0">
              Add
            </Button>
          </div>
        </Field>
        <Field label="Add a range">
          <div className="flex gap-2">
            <Input
              size="sm"
              type="text"
              placeholder="e.g. A1-A50"
              value={bulkRange}
              onChange={(e) => setBulkRange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addRange()}
              className="min-w-0"
            />
            <Button variant="outline" onClick={addRange} disabled={saving || !bulkRange.trim()} className="shrink-0">
              Add range
            </Button>
          </div>
        </Field>
      </div>

      {error && <p className="mb-3 text-sm font-medium text-danger">{error}</p>}

      <div className="mb-5 rounded-lg border border-border bg-background p-3">
        <Field label="Print barcode labels" hint={'1" x 2" labels — one per location, each with a scannable barcode.'}>
          <div className="flex gap-2">
            <Input
              size="sm"
              type="text"
              placeholder="Blank = all, or a range like A25-A40"
              value={printRange}
              onChange={(e) => setPrintRange(e.target.value)}
              className="min-w-0"
            />
            <a
              href={`/settings/labels${printRange.trim() ? `?range=${encodeURIComponent(printRange.trim())}` : ""}`}
              target="_blank"
              rel="noreferrer"
              className={buttonClasses({ className: "shrink-0" })}
            >
              <Printer className="size-4" aria-hidden />
              Print
            </a>
          </div>
        </Field>
      </div>

      {!entries ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet — add one above.</p>
      ) : (
        <LabelChips entries={entries} onRemove={removeEntry} />
      )}
    </Card>
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
    <Card>
      <SectionHeader
        title="Expiration removal buffer"
        description={
          <>
            The daily sweep ends a listing this many days <strong>before</strong> its printed expiration date — not
            on the date itself — so a sale made right before removal still has time to process and ship before the
            item actually expires. Applies to both the eBay removal and the &quot;needs shelf pull&quot; notification on
            the dashboard.
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <SuffixInput
          suffix="days"
          step="1"
          min={0}
          value={value}
          aria-label="Days before expiration"
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
        />
        <SaveButton onClick={save} disabled={saving || !value} saving={saving} saved={saved} />
      </div>
    </Card>
  );
}
