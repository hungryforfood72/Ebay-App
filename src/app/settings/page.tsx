"use client";

import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Input";
import type { BoxSizeDto } from "@/lib/warehouse/boxSizes";
import { printLabelBatch } from "@/lib/warehouse/labelPrint";
import type { StationStatus } from "@/lib/warehouse/types";
import { Check, ExternalLink, Pencil, Printer, Trash2, X } from "lucide-react";
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
          <EbaySaleAlerts />
          <ShopifyConnection />
          <DealAlertsCard />
        </SettingsGroup>

        <SettingsGroup title="Scanning">
          <ShelfLocationsEditor />
        </SettingsGroup>

        <SettingsGroup title="Warehouse" id="warehouse">
          <WarehouseModeCard />
          <StationsManager />
          <BoxSizesEditor />
        </SettingsGroup>

        <SettingsGroup title="Sourcing agent">
          <SourcingMarginSetting />
          <MaxMonthsToSellThroughSetting />
          <LongTailMonthsSetting />
          <UnprovenMarginSetting />
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

function SettingsGroup({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
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
        title="Full-value sell-through"
        description="Items that would sell through within this count at your normal target margin. Slower ones that expire (sunscreen, medicine, food) are duds past this point. Slower ones that don't expire go by the next setting."
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

// Longest sell-through for non-expiring stock that still counts (at the
// cheap margin below) — see getLongTailMonths. Same fetch/save pattern.
function LongTailMonthsSetting() {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    fetch("/api/settings/sourcing-long-tail-months")
      .then((r) => r.json())
      .then((data: { longTailMonths: number }) => setValue(String(data.longTailMonths)));
  }

  useEffect(load, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/sourcing-long-tail-months", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ longTailMonths: Number(value) }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Longest wait for items that don't expire"
        description="Slow sellers that don't expire still count toward the bid up to this many months, at the unproven-and-slow margin below. They're bonus profit, not what the buy depends on. Slower than this is a dud."
      />
      <div className="flex flex-wrap items-center gap-3">
        <SuffixInput
          suffix="months"
          step="1"
          min={1}
          value={value}
          aria-label="Longest wait for items that don't expire, in months"
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

// Margin for lines the Analyzer has no sell-speed evidence on at all, so
// they only get bought cheap (getUnprovenMarginPct). Same fetch/save
// pattern as SourcingMarginSetting.
function UnprovenMarginSetting() {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    fetch("/api/settings/sourcing-unproven-margin")
      .then((r) => r.json())
      .then((data: { unprovenMarginPct: number }) => setValue(String(data.unprovenMarginPct)));
  }

  useEffect(load, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/sourcing-unproven-margin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unprovenMarginPct: Number(value) }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Margin on unproven and slow items"
        description="For items with no proof of how fast they sell, and for slow sellers that don't expire. They still count toward the bid, but at this margin instead, so you only pay a little for them and the fast sellers carry the buy. 100% means paying at most half of what they're expected to net."
      />
      <div className="flex flex-wrap items-center gap-3">
        <SuffixInput
          suffix="%"
          step="5"
          min={0}
          value={value}
          aria-label="Margin on unproven items in percent"
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

type ShopifyStatus = {
  configured: boolean;
  missingEnvVars?: string[];
  discountPct: number;
  shop?: { name: string; domain: string } | null;
  missingScopes?: string[];
  location?: { id: string; name: string } | null;
  channels?: string[] | null;
  webhookUrl?: string;
  missingWebhooks?: string[] | null;
  counts?: { onShopify: number; waiting: number; failed: number };
  recentErrors?: { id: string; finalTitle: string | null; shopifyError: string | null }[];
  errors?: string[];
};

// The Shopify store every eBay listing also goes on (and Whatnot sells
// from). The connection itself is three Vercel env vars, which Cristian
// sets in the dashboard; this shows whether they work and what's missing.
function ShopifyConnection() {
  const [status, setStatus] = useState<ShopifyStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"webhooks" | "publish" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [discount, setDiscount] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    fetch("/api/shopify/status")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Couldn't load Shopify status.");
        return data as ShopifyStatus;
      })
      .then((data) => {
        setStatus(data);
        setDiscount(String(data.discountPct));
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load Shopify status."));
  }

  useEffect(load, []);

  async function setUpWebhooks() {
    setBusy("webhooks");
    setMessage(null);
    try {
      const res = await fetch("/api/shopify/setup-webhooks", { method: "POST" });
      const data = await res.json();
      setMessage(res.ok ? `Order webhooks set up (${data.created} added).` : data.error);
      load();
    } finally {
      setBusy(null);
    }
  }

  async function publishWaiting() {
    setBusy("publish");
    setMessage(null);
    try {
      const res = await fetch("/api/shopify/publish-waiting", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error ?? "Something went wrong.");
      } else {
        const problems: string[] = data.errors ?? [];
        setMessage(
          `${data.published} item(s) put on Shopify.` +
            (problems.length ? ` ${problems.length} problem(s): ${problems.slice(0, 3).join(" · ")}` : "")
        );
      }
      load();
    } finally {
      setBusy(null);
    }
  }

  async function saveDiscount() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/shopify-discount", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discountPct: Number(discount) }),
      });
      if (res.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  const connected = Boolean(status?.shop);
  const missingWebhooks = (status?.missingWebhooks?.length ?? 0) > 0;
  const needsAttention = connected && ((status?.missingScopes?.length ?? 0) > 0 || missingWebhooks);

  return (
    <Card>
      <SectionHeader
        title="Shopify store"
        description="Every item that goes live on eBay also goes on Shopify (and Whatnot, through its Shopify app), all selling from one stock count."
      />
      {loadError && <p className="mb-3 text-sm font-medium text-danger">{loadError}</p>}
      {!status ? (
        !loadError && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !status.configured ? (
        <p className="text-sm text-muted-foreground">
          Not set up. Add these in Vercel (Settings → Environment Variables), then redeploy:{" "}
          <strong>{status.missingEnvVars?.join(", ")}</strong>.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <span
                className={
                  connected && !needsAttention
                    ? "size-2.5 rounded-full bg-green-500"
                    : connected
                      ? "size-2.5 rounded-full bg-amber-500"
                      : "size-2.5 rounded-full bg-red-500"
                }
                aria-hidden
              />
              {status.shop ? status.shop.name : "Can't reach Shopify"}
              {status.shop && <Badge>{status.shop.domain}</Badge>}
            </p>
            {status.location && (
              <p className="mt-0.5 text-xs text-muted-foreground">Stock kept at: {status.location.name}</p>
            )}
            {status.channels && (
              <p className="mt-0.5 text-xs text-muted-foreground">Sales channels: {status.channels.join(", ")}</p>
            )}
            {status.counts && (
              <p className="mt-1 text-sm text-foreground">
                {status.counts.onShopify} on Shopify · {status.counts.waiting} waiting
                {status.counts.failed > 0 && <span className="text-danger"> · {status.counts.failed} failed</span>}
              </p>
            )}
            {(status.missingScopes?.length ?? 0) > 0 && (
              <p className="mt-1 text-xs font-medium text-warning">
                The Shopify app is missing these permissions: {status.missingScopes!.join(", ")}. Add them in the Dev
                Dashboard, release a new version, and approve it on the store.
              </p>
            )}
            {status.errors?.map((e) => (
              <p key={e} className="mt-1 text-xs font-medium text-danger">
                {e}
              </p>
            ))}
          </div>

          {connected && (
            <div className="flex flex-wrap gap-2">
              {missingWebhooks && (
                <Button size="sm" onClick={setUpWebhooks} disabled={busy !== null}>
                  {busy === "webhooks" ? "Setting up…" : "Set up order webhooks"}
                </Button>
              )}
              {status.counts && status.counts.waiting + status.counts.failed > 0 && (
                <Button size="sm" variant="outline" onClick={publishWaiting} disabled={busy !== null}>
                  {busy === "publish" ? "Sending…" : "Send waiting items now"}
                </Button>
              )}
            </div>
          )}
          {connected && missingWebhooks && (
            <p className="text-xs text-muted-foreground">
              Order webhooks let a Shopify or Whatnot sale come off eBay within seconds. They&apos;ll point at{" "}
              {status.webhookUrl}, so press this from the app&apos;s real domain. Without them, sales still sync every
              10 minutes.
            </p>
          )}
          {message && <p className="text-sm text-foreground">{message}</p>}

          <div>
            <p className="mb-1 text-sm font-medium text-foreground">Shopify price</p>
            <p className="mb-2 text-xs text-muted-foreground">
              How far under the eBay price, since Shopify buyers pay their own shipping. Follows every eBay price
              change, discounts included.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <SuffixInput
                suffix="% off"
                step="1"
                min={0}
                value={discount}
                aria-label="Shopify discount percent"
                onChange={(e) => {
                  setDiscount(e.target.value);
                  setSaved(false);
                }}
              />
              <SaveButton onClick={saveDiscount} disabled={saving || discount === ""} saving={saving} saved={saved} />
            </div>
          </div>

          {(status.recentErrors?.length ?? 0) > 0 && (
            <div>
              <p className="mb-1 text-sm font-medium text-foreground">Recent Shopify problems</p>
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {status.recentErrors!.map((e) => (
                  <li key={e.id}>
                    <span className="font-medium text-foreground">{e.finalTitle ?? e.id}:</span> {e.shopifyError}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// Epic Steals deal alerts (web push to shoppers who opted in on the store):
// how many signed up, and a test alert to check it end to end.
function DealAlertsCard() {
  const [subscribers, setSubscribers] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetch("/api/deal-alerts")
      .then((r) => r.json())
      .then((d: { subscribers?: number }) => setSubscribers(d.subscribers ?? null))
      .catch(() => setSubscribers(null));
  }

  useEffect(load, []);

  async function sendTest() {
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/deal-alerts", { method: "POST" });
      const d = await res.json();
      setMessage(
        res.ok
          ? `Sent to ${d.sent} device(s).${d.removed ? ` ${d.removed} had turned alerts off and were removed.` : ""}${d.failed ? ` ${d.failed} failed.` : ""}`
          : (d.error ?? "Couldn't send.")
      );
      load();
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Deal alerts"
        description="Phone notifications for Epic Steals shoppers who tap Get deal alerts: one at 6 PM when 3 or more new items went up that day, and one when items move to the past-date page."
      />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
        <p className="text-sm text-foreground">
          {subscribers == null ? "Loading…" : `${subscribers} device${subscribers === 1 ? "" : "s"} signed up`}
        </p>
        <Button size="sm" variant="outline" onClick={sendTest} disabled={sending || !subscribers}>
          {sending ? "Sending…" : "Send test alert"}
        </Button>
      </div>
      {message && <p className="mt-2 text-sm text-foreground">{message}</p>}
    </Card>
  );
}

type SaleAlertStatus = {
  hasScope: boolean;
  endpoint: string | null;
  subscriptionStatus: string | null;
  lastReceived: { at: string; verified: boolean; orderId: string | null; test: boolean } | null;
};

// eBay's instant sale alerts: an eBay sale comes off Shopify within seconds
// instead of at the next 10-minute sync.
function EbaySaleAlerts() {
  const [status, setStatus] = useState<SaleAlertStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetch("/api/ebay/notifications/setup")
      .then((r) => r.json())
      .then((data) => setStatus(data as SaleAlertStatus))
      .catch(() => setStatus(null));
  }

  useEffect(load, []);

  async function turnOn() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/ebay/notifications/setup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error ?? "Couldn't turn on sale alerts.");
      } else {
        setStatus(data);
        setMessage("Turned on. eBay is sending a test alert now; refresh in a minute to see it below.");
      }
    } finally {
      setBusy(false);
    }
  }

  const on = status?.subscriptionStatus === "ENABLED";

  return (
    <Card>
      <SectionHeader
        title="eBay instant sale alerts"
        description="eBay tells the app the moment something sells, so Shopify and Whatnot drop that unit within seconds. The 10-minute sync stays on as a backup."
      />
      {!status ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium text-foreground">
                <span
                  className={on ? "size-2.5 rounded-full bg-green-500" : "size-2.5 rounded-full bg-zinc-300"}
                  aria-hidden
                />
                {on
                  ? "On"
                  : status.subscriptionStatus
                    ? `Subscription ${status.subscriptionStatus.toLowerCase()}`
                    : "Off"}
              </p>
              {status.lastReceived ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Last alert: {new Date(status.lastReceived.at).toLocaleString()}
                  {status.lastReceived.test ? " (test)" : ""}
                  {!status.lastReceived.verified && (
                    <span className="font-medium text-danger"> · signature didn&apos;t check out, ignored</span>
                  )}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-muted-foreground">No alerts received yet.</p>
              )}
              {!status.hasScope && (
                <p className="mt-1 text-xs font-medium text-warning">
                  Needs one more eBay permission. Reconnect eBay first; everything else stays as it is.
                </p>
              )}
            </div>
            {!status.hasScope ? (
              <a href="/api/ebay/connect" className={buttonClasses({ size: "sm" })}>
                Reconnect eBay
              </a>
            ) : (
              <Button size="sm" variant={on ? "outline" : "primary"} onClick={turnOn} disabled={busy}>
                {busy ? "Working…" : on ? "Re-check" : "Turn on"}
              </Button>
            )}
          </div>
          {message && <p className="text-sm text-foreground">{message}</p>}
        </div>
      )}
    </Card>
  );
}

// Shelf locations get their own editor because they also support adding a
// whole range at once (e.g. "A1-A50") and printing scannable barcode labels
// for a range.
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

// Warehouse mode switch (src/lib/warehouse/settings.ts). The nav links for
// Sort, Bins, Pick orders and Station appear once it's on.
function WarehouseModeCard() {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/warehouse/mode")
      .then((r) => r.json())
      .then((d: { on: boolean }) => setOn(d.on));
  }, []);

  async function toggle() {
    if (on === null) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/warehouse/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on: !on }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Couldn't change it.");
      setOn(d.on);
      setMessage("Saved. Reload other open pages to see the change in the menu.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Warehouse mode"
        description="Bins, item labels, the station scale and order picking. New items get a label code (like ES000123) as their SKU. Items listed before keep their shelf location and SKU."
      />
      {on === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <span className={on ? "size-2.5 rounded-full bg-green-500" : "size-2.5 rounded-full bg-zinc-300"} aria-hidden />
            {on ? "On" : "Off"}
          </p>
          <Button size="sm" variant={on ? "outline" : "primary"} onClick={toggle} disabled={saving}>
            {saving ? "Saving…" : on ? "Turn off" : "Turn on"}
          </Button>
        </div>
      )}
      {message && <p className="mt-2 text-sm text-foreground">{message}</p>}
    </Card>
  );
}

// Listing stations: a PC with the scale and the Rollo, running the
// /station/{id} page. Handhelds pick one to get their weight from, and its
// labels print there.
function StationsManager() {
  const [stations, setStations] = useState<StationStatus[] | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetch("/api/stations")
      .then((r) => r.json())
      .then((d: StationStatus[]) => setStations(d));
  }

  useEffect(load, []);

  async function add() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/stations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Couldn't add the station.");
      setName("");
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(s: StationStatus) {
    if (!confirm(`Delete "${s.name}"? Its print history goes with it, and handhelds using it will need to pick another.`)) return;
    setError(null);
    const res = await fetch(`/api/stations/${s.id}`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "Couldn't delete the station.");
    }
    load();
  }

  return (
    <Card>
      <SectionHeader
        title="Stations"
        description="Each listing station is a PC with the scale and label printer. Open its page on that PC and leave it open; the page has setup steps."
        action={stations && stations.length > 0 ? <Badge>{stations.length}</Badge> : undefined}
      />
      <div className="mb-4 flex gap-2">
        <Input
          size="sm"
          type="text"
          placeholder="e.g. Station 1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          aria-label="New station name"
          className="min-w-0"
        />
        <Button onClick={add} disabled={saving || !name.trim()} className="shrink-0">
          Add
        </Button>
      </div>
      {error && <p className="mb-3 text-sm font-medium text-danger">{error}</p>}
      {!stations ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : stations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No stations yet. Add one above.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {stations.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium text-foreground">
                  <span className="truncate">{s.name}</span>
                  <Badge tone={s.online ? "success" : "neutral"}>{s.online ? "Online" : "Offline"}</Badge>
                </p>
                {s.online && s.weightOz !== null && (
                  <p className="text-xs text-muted-foreground">Scale reads {s.weightOz.toFixed(1)} oz</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <a
                  href={`/station/${s.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClasses({ variant: "outline", size: "sm" })}
                >
                  <ExternalLink className="size-4" aria-hidden />
                  Open
                </a>
                <Button variant="danger-ghost" size="sm" onClick={() => remove(s)} aria-label={`Delete ${s.name}`}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type BoxForm = { label: string; code: string; tareOz: string; lengthIn: string; widthIn: string; heightIn: string };

const EMPTY_BOX_FORM: BoxForm = { label: "", code: "", tareOz: "", lengthIn: "", widthIn: "", heightIn: "" };

function boxToForm(b: BoxSizeDto): BoxForm {
  const str = (n: number | null) => (n == null ? "" : String(n));
  return {
    label: b.label,
    code: b.code ?? "",
    tareOz: str(b.tareOz),
    lengthIn: str(b.lengthIn),
    widthIn: str(b.widthIn),
    heightIn: str(b.heightIn),
  };
}

// "Empty 3.2 oz · 6 x 4 x 2 in", or what's missing.
function boxDetails(b: BoxSizeDto): string {
  const parts = [b.tareOz != null ? `Empty ${b.tareOz} oz` : "No empty weight yet"];
  if (b.lengthIn != null && b.widthIn != null && b.heightIn != null) {
    parts.push(`${b.lengthIn} x ${b.widthIn} x ${b.heightIn} in`);
  }
  return parts.join(" · ");
}

// Number input with a short unit inside it, sized to fill its grid cell
// (SuffixInput above is a fixed width).
function UnitInput({ suffix, ...props }: Omit<React.ComponentProps<typeof Input>, "type" | "size"> & { suffix: string }) {
  return (
    <div className="relative">
      <Input size="sm" type="number" min={0} {...props} className="pr-10" />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
        {suffix}
      </span>
    </div>
  );
}

// The fields for adding or editing a box.
function BoxFields({ form, onChange }: { form: BoxForm; onChange: (form: BoxForm) => void }) {
  const set = (key: keyof BoxForm) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...form, [key]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_7rem_9rem]">
      <Field label="Name">
        <Input size="sm" type="text" placeholder="e.g. Small 6x4x2" value={form.label} onChange={set("label")} />
      </Field>
      <Field label="Code" hint="Blank = next one">
        <Input size="sm" type="text" autoCapitalize="characters" placeholder="BX001" value={form.code} onChange={set("code")} />
      </Field>
      <Field label="Empty box weight">
        <UnitInput suffix="oz" step="0.1" value={form.tareOz} onChange={set("tareOz")} />
      </Field>
      <div className="grid grid-cols-3 gap-2 sm:col-span-3 sm:max-w-sm">
        <Field label="Length">
          <UnitInput suffix="in" step="0.25" value={form.lengthIn} onChange={set("lengthIn")} />
        </Field>
        <Field label="Width">
          <UnitInput suffix="in" step="0.25" value={form.widthIn} onChange={set("widthIn")} />
        </Field>
        <Field label="Height">
          <UnitInput suffix="in" step="0.25" value={form.heightIn} onChange={set("heightIn")} />
        </Field>
      </div>
    </div>
  );
}

// Box sizes: the Box Size dropdown on the scan and review pages, and in
// warehouse mode a barcode for each (stuck up at the station) that the
// lister scans so the empty box's weight gets added to the scale reading.
// Codes are given out automatically (BX001, BX002...); boxes from before
// warehouse mode got theirs the first time the list loaded.
const PRINT_HERE = "here";

function BoxSizesEditor() {
  const [boxes, setBoxes] = useState<BoxSizeDto[] | null>(null);
  const [stations, setStations] = useState<StationStatus[]>([]);
  const [newBox, setNewBox] = useState<BoxForm>(EMPTY_BOX_FORM);
  const [editing, setEditing] = useState<{ id: string; form: BoxForm } | null>(null);
  const [target, setTarget] = useState(PRINT_HERE);
  const [copies, setCopies] = useState("1");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printMessage, setPrintMessage] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/box-sizes");
    setBoxes(await res.json());
  }

  useEffect(() => {
    // Initial data load on mount, not a reaction to state we own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    fetch("/api/stations")
      .then((r) => (r.ok ? r.json() : []))
      .then((d: StationStatus[]) => {
        setStations(d);
        // Default to a station that's open right now, else print here.
        const online = d.find((s) => s.online);
        if (online) setTarget(online.id);
      })
      .catch(() => {});
  }, []);

  async function save(id: string | null, form: BoxForm): Promise<boolean> {
    if (!form.label.trim()) return false;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(id ? `/api/box-sizes/${id}` : "/api/box-sizes", {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Couldn't save the box.");
      }
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function remove(b: BoxSizeDto) {
    if (!confirm(`Remove "${b.label}"?${b.code ? ` Its barcode (${b.code}) stops working.` : ""}`)) return;
    setBoxes((prev) => prev?.filter((x) => x.id !== b.id) ?? prev);
    await fetch(`/api/box-sizes/${b.id}`, { method: "DELETE" });
  }

  async function print(list: BoxSizeDto[]) {
    const n = Number(copies);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      setPrintMessage("Copies must be 1 to 50.");
      return;
    }
    const labels = list
      .filter((b) => b.code)
      .map((b) => ({ kind: "box" as const, payload: { code: b.code!, caption: b.label }, copies: n }));
    if (labels.length === 0) return;
    setPrintMessage(null);
    try {
      if (target === PRINT_HERE) {
        await printLabelBatch(labels);
        return;
      }
      for (const label of labels) {
        const res = await fetch(`/api/stations/${target}/print`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(label),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? "Couldn't send the labels.");
        }
      }
      const station = stations.find((s) => s.id === target);
      const total = labels.length * n;
      setPrintMessage(
        `Sent ${total} label${total === 1 ? "" : "s"} to ${station?.name ?? "the station"}.` +
          (station && !station.online ? " It's offline, so they'll print once its page is open." : "")
      );
    } catch (e) {
      setPrintMessage(e instanceof Error ? e.message : "Couldn't print.");
    }
  }

  return (
    <Card>
      <SectionHeader
        title="Box sizes"
        description="The Box Size dropdown on the scan and review pages. In warehouse mode, stick each box's barcode up at the station: scanning it adds the empty box's weight to the scale reading."
        action={boxes && boxes.length > 0 ? <Badge>{boxes.length}</Badge> : undefined}
      />

      <div className="mb-4 rounded-lg border border-border bg-background p-3">
        <p className="mb-2 text-sm font-medium text-foreground">Add a box</p>
        <BoxFields form={newBox} onChange={setNewBox} />
        <Button
          className="mt-1"
          onClick={async () => {
            if (await save(null, newBox)) setNewBox(EMPTY_BOX_FORM);
          }}
          disabled={saving || !newBox.label.trim()}
        >
          Add box
        </Button>
      </div>

      {error && <p className="mb-3 text-sm font-medium text-danger">{error}</p>}

      {!boxes ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : boxes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No boxes yet. Add one above.</p>
      ) : (
        <>
          <ul className="mb-4 divide-y divide-border rounded-lg border border-border">
            {boxes.map((b) =>
              editing?.id === b.id ? (
                <li key={b.id} className="px-3 py-3">
                  <BoxFields form={editing.form} onChange={(form) => setEditing({ id: b.id, form })} />
                  <div className="mt-1 flex gap-2">
                    <Button
                      size="sm"
                      onClick={async () => {
                        if (await save(b.id, editing.form)) setEditing(null);
                      }}
                      disabled={saving || !editing.form.label.trim()}
                    >
                      {saving ? "Saving…" : "Save"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </li>
              ) : (
                <li key={b.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium text-foreground">
                      {b.code && <Badge className="font-mono">{b.code}</Badge>}
                      <span className="truncate">{b.label}</span>
                    </p>
                    <p className={b.tareOz == null ? "text-xs text-warning" : "text-xs text-muted-foreground"}>
                      {boxDetails(b)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => print([b])}
                      disabled={!b.code}
                      aria-label={`Print barcode for ${b.label}`}
                    >
                      <Printer className="size-4" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing({ id: b.id, form: boxToForm(b) })}
                      aria-label={`Edit ${b.label}`}
                    >
                      <Pencil className="size-4" aria-hidden />
                    </Button>
                    <Button variant="danger-ghost" size="sm" onClick={() => remove(b)} aria-label={`Remove ${b.label}`}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                </li>
              )
            )}
          </ul>

          <div className="rounded-lg border border-border bg-background p-3">
            <p className="mb-2 text-sm font-medium text-foreground">Print box barcodes</p>
            <div className="grid gap-3 sm:grid-cols-[1fr_7rem_auto] sm:items-end">
              <Field label="Print on">
                <Select size="sm" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {stations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.online ? "" : " (offline)"}
                    </option>
                  ))}
                  <option value={PRINT_HERE}>This computer</option>
                </Select>
              </Field>
              <Field label="Copies each">
                <Input size="sm" type="number" min={1} max={50} value={copies} onChange={(e) => setCopies(e.target.value)} />
              </Field>
              <Button onClick={() => print(boxes)}>
                <Printer className="size-4" aria-hidden />
                Print all ({boxes.length})
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">2 x 1 in labels. The printer button on a box prints just that one.</p>
            {printMessage && <p className="mt-2 text-sm text-foreground">{printMessage}</p>}
          </div>
        </>
      )}
    </Card>
  );
}
