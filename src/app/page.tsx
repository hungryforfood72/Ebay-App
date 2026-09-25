"use client";

import { Stat } from "@/components/Stat";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Input, Select } from "@/components/ui/Input";
import { ClipboardCheck, ExternalLink, RefreshCw, ScanBarcode } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

type ExpiringListedItem = {
  id: string;
  finalTitle: string | null;
  sku: string;
  expirationDate: string;
  price: number | null;
  shelfLocation: string;
  ebayListingId: string | null;
  ebayEnvironment: string | null;
  ebayAdId: string | null;
  promotedBidPercentage: number | null;
  ebayPublishError: string | null;
  ebayPromoteError: string | null;
  ebayMarkdownId: string | null;
  markdownPercentOff: number | null;
  markdownEndsAt: string | null;
  ebayMarkdownError: string | null;
  livePrice: number | null;
  liveOriginalPrice: number | null;
};

function ebayListingUrl(item: Pick<ExpiringListedItem, "ebayListingId" | "ebayEnvironment">): string | null {
  if (!item.ebayListingId) return null;
  return item.ebayEnvironment === "production"
    ? `https://www.ebay.com/itm/${item.ebayListingId}`
    : `https://sandbox.ebay.com/itm/${item.ebayListingId}`;
}

type ExpiringUnlistedItem = {
  id: string;
  finalTitle: string | null;
  sku: string;
  expirationDate: string;
  status: string;
};

type ExpiredNeedingPullItem = {
  id: string;
  finalTitle: string | null;
  sku: string;
  shelfLocation: string;
  expirationDate: string | null;
  expiredAt: string;
};

type ExpiredEndFailedItem = {
  id: string;
  finalTitle: string | null;
  sku: string;
  expirationDate: string | null;
  ebayEndError: string;
};

type DashboardData = {
  // Owner-only controls (discount/promote/sale events, linking legacy
  // listings) are hidden for an employee — who can still see everything
  // expiring. The API routes behind them enforce owner-only on their own.
  isOwner: boolean;
  stats: {
    pendingReview: number;
    readyToPublish: number;
    listed: number;
    expiringCount: number;
  };
  ebay: { connected: boolean; missingScopes: string[] };
  expiringListed: ExpiringListedItem[];
  expiringUnlisted: ExpiringUnlistedItem[];
  expiredNeedingPull: ExpiredNeedingPullItem[];
  // Owner-only — see /api/dashboard's isOwner check.
  expiredEndFailed?: ExpiredEndFailedItem[];
};

function shortScopeName(scope: string): string {
  return scope.split("/").pop() ?? scope;
}

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

type SyncResult = {
  skipped?: string;
  ordersScanned: number;
  itemsUpdated: number;
  itemsAlreadySynced: number;
  itemsUnmatched: number;
  refundsRecorded: number;
  salesReversed: number;
  errors: string[];
};

type LinkLegacyResult = { checked: number; linked: number; notFound: number };

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkResult, setLinkResult] = useState<LinkLegacyResult | string | null>(null);
  // Bumped after a sync so the sales section refetches its own range.
  const [salesRefresh, setSalesRefresh] = useState(0);

  function load() {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then(setData);
  }

  useEffect(load, []);

  // Same sync the cron job runs every 4 hours (src/lib/ebayOrderSync.ts) —
  // manual trigger for testing or when Cristian doesn't want to wait.
  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/ebay/sync", { method: "POST" });
      const result = await res.json();
      setSyncResult(result);
      load();
      setSalesRefresh((n) => n + 1);
    } catch {
      setSyncResult({
        ordersScanned: 0,
        itemsUpdated: 0,
        itemsAlreadySynced: 0,
        itemsUnmatched: 0,
        refundsRecorded: 0,
        salesReversed: 0,
        errors: ["Sync request failed."],
      });
    } finally {
      setSyncing(false);
    }
  }

  // Looks up every "exported" (CSV bulk-uploaded, never through this app's
  // real API) item app-wide against eBay's real listings by SKU, and links
  // up whatever's still active — not scoped to just what's visible here.
  async function linkLegacyListings() {
    setLinking(true);
    setLinkResult(null);
    try {
      const res = await fetch("/api/items/link-legacy", { method: "POST" });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Failed to check eBay.");
      setLinkResult(result);
      load();
    } catch (e) {
      setLinkResult(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLinking(false);
    }
  }

  function updateItem(id: string, patch: Partial<ExpiringListedItem>) {
    setData((prev) =>
      prev
        ? { ...prev, expiringListed: prev.expiringListed.map((i) => (i.id === id ? { ...i, ...patch } : i)) }
        : prev
    );
  }

  function removeExpiredNeedingPull(id: string) {
    setData((prev) =>
      prev ? { ...prev, expiredNeedingPull: prev.expiredNeedingPull.filter((i) => i.id !== id) } : prev
    );
  }

  if (!data) {
    return (
      <AppShell title="Dashboard" subtitle="Sticker Peak eBay tool — overview">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    );
  }

  const { isOwner, stats, ebay, expiringListed, expiringUnlisted, expiredNeedingPull, expiredEndFailed } = data;

  return (
    <AppShell title="Dashboard" subtitle="Sticker Peak eBay tool — overview">
      <div className="flex flex-col gap-6 sm:gap-8">
        {(!ebay.connected || ebay.missingScopes.length > 0) && (
          <Alert
            tone="warning"
            title={!ebay.connected ? "eBay isn't connected" : "eBay reconnect required"}
            action={
              <Link href="/settings" className={buttonClasses({ variant: "outline", size: "sm" })}>
                {!ebay.connected ? "Connect in Settings" : "Reconnect in Settings"}
              </Link>
            }
          >
            {!ebay.connected
              ? "Connect it to publish, sync sales, or promote listings."
              : `Missing permissions: ${ebay.missingScopes.map(shortScopeName).join(", ")}.`}
          </Alert>
        )}

        {/* Stacked on phones: half of a ~360px screen can't fit an icon +
            "Review queue" at a comfortable tap size. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Link href="/scan" className={buttonClasses({ variant: "primary", size: "xl", block: true })}>
            <ScanBarcode className="size-5" aria-hidden />
            Scan items
          </Link>
          <Link href="/review" className={buttonClasses({ variant: "outline", size: "xl", block: true })}>
            <ClipboardCheck className="size-5" aria-hidden />
            Review queue
          </Link>
        </div>

        <section>
          <SectionHeader title="Inventory" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Pending review" value={stats.pendingReview} />
            <Stat label="Ready to publish" value={stats.readyToPublish} />
            <Stat label="Listed" value={stats.listed} />
            <Stat label="Expiring ≤21 days" value={stats.expiringCount} highlight={stats.expiringCount > 0} />
          </div>
        </section>

        <SalesSection isOwner={isOwner} refreshKey={salesRefresh} />

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-foreground">Sold-order sync</p>
              <p className="text-sm text-muted-foreground">Runs automatically every 4 hours — or trigger it now.</p>
            </div>
            <Button variant="outline" onClick={syncNow} disabled={syncing}>
              <RefreshCw className={cn("size-4", syncing && "animate-spin")} aria-hidden />
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          </div>
          {syncResult && (
            <div className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
              {syncResult.skipped ? (
                <p className="text-warning">{syncResult.skipped}</p>
              ) : (
                <p>
                  Scanned {syncResult.ordersScanned} order(s) — {syncResult.itemsUpdated} item(s) updated,{" "}
                  {syncResult.itemsAlreadySynced} already synced, {syncResult.itemsUnmatched} unmatched,{" "}
                  {syncResult.refundsRecorded} refund(s) recorded
                  {syncResult.salesReversed > 0
                    ? `, ${syncResult.salesReversed} sale(s) reversed (cancelled after being recorded)`
                    : ""}
                  .
                </p>
              )}
              {syncResult.errors.length > 0 && <p className="mt-1 text-danger">{syncResult.errors.join(" · ")}</p>}
            </div>
          )}
        </Card>

        {expiredNeedingPull.length > 0 && (
          <Alert tone="danger" title={`Expired — needs shelf pull (${expiredNeedingPull.length})`}>
            <p>
              These listings were automatically removed from eBay ahead of their expiration date (per the removal
              buffer in Settings, to stay compliant with eBay&apos;s food policy — items must be delivered before
              they expire). Pull the physical stock off the shelf, then mark it done below.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {expiredNeedingPull.map((item) => (
                <ShelfPullRow key={item.id} item={item} onAcknowledged={() => removeExpiredNeedingPull(item.id)} />
              ))}
            </div>
          </Alert>
        )}

        {expiredEndFailed && expiredEndFailed.length > 0 && (
          <Alert tone="danger" title={`Expired listings eBay wouldn't remove (${expiredEndFailed.length})`}>
            <p>
              Inside their removal window (expiring soon, per the buffer in Settings), but the automatic eBay
              removal failed — still genuinely live and buyable, so nothing&apos;s been pulled off the shelf for
              these. Retried automatically every hour; check the eBay connection in Settings if this persists.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {expiredEndFailed.map((item) => (
                <div key={item.id} className="rounded-lg border border-red-200 bg-surface p-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 font-medium text-foreground">{item.finalTitle ?? item.sku}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {item.expirationDate ? new Date(item.expirationDate).toLocaleDateString() : "—"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-danger">{item.ebayEndError}</p>
                </div>
              ))}
            </div>
          </Alert>
        )}

        {expiringUnlisted.length > 0 && (
          <Alert
            tone="warning"
            title={`Expiring soon — not yet published (${expiringUnlisted.length})`}
            action={
              <Link href="/review" className={buttonClasses({ variant: "outline", size: "sm" })}>
                Go to review queue
              </Link>
            }
          >
            <p>
              These have no live eBay listing on file yet.
              {isOwner &&
                " If one was already bulk-uploaded via the old CSV flow before this app tracked listing IDs, check for it below instead of re-publishing."}
            </p>
            {isOwner && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button variant="outline" size="sm" onClick={linkLegacyListings} disabled={linking}>
                  {linking ? "Checking eBay…" : "Check eBay for existing listings"}
                </Button>
                <span className="text-xs opacity-80">Checks every exported item app-wide, not just these.</span>
              </div>
            )}
            {linkResult && (
              <p className="mt-2 text-xs">
                {typeof linkResult === "string"
                  ? linkResult
                  : `Checked ${linkResult.checked} — linked ${linkResult.linked}, ${linkResult.notFound} not found on eBay.`}
              </p>
            )}
            <ul className="mt-3 divide-y divide-amber-200 rounded-lg border border-amber-200 bg-surface">
              {expiringUnlisted.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-3 px-3 py-2 text-foreground">
                  <span className="min-w-0">{item.finalTitle ?? item.sku}</span>
                  <span
                    className={cn(
                      "shrink-0",
                      daysUntil(item.expirationDate) <= 7 ? "font-semibold text-danger" : "text-muted-foreground"
                    )}
                  >
                    {new Date(item.expirationDate).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          </Alert>
        )}

        <section>
          <SectionHeader
            title="Expiring soon — listed"
            action={<Badge tone={expiringListed.length > 0 ? "warning" : "neutral"}>{expiringListed.length}</Badge>}
          />
          {expiringListed.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground">Nothing listed is expiring in the next 21 days.</p>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {expiringListed.map((item) => (
                <ExpiringItemCard
                  key={item.id}
                  item={item}
                  canManage={isOwner}
                  onChange={(patch) => updateItem(item.id, patch)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function ShelfPullRow({
  item,
  onAcknowledged,
}: {
  item: ExpiredNeedingPullItem;
  onAcknowledged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function acknowledge() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/acknowledge-shelf-pull`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to acknowledge.");
      }
      onAcknowledged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-surface p-3">
      <div className="min-w-0">
        <p className="font-medium text-foreground">{item.finalTitle ?? item.sku}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge>Shelf {item.shelfLocation || "—"}</Badge>
          Expired{" "}
          {item.expirationDate
            ? new Date(item.expirationDate).toLocaleDateString()
            : new Date(item.expiredAt).toLocaleDateString()}
        </p>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      <Button size="sm" onClick={acknowledge} disabled={saving} className="shrink-0">
        {saving ? "Saving…" : "Mark as pulled"}
      </Button>
    </div>
  );
}

type SalesSummary = {
  units: number;
  // Owner only — /api/dashboard/sales leaves these out for an employee.
  revenue?: number;
  fees?: number;
  shipping?: number;
  refunded?: number;
  profit?: number;
};

type SalesPreset = "mtd" | "last-month" | "last-30" | "qtd" | "ytd" | "last-year" | "all" | "custom";

const SALES_PRESETS: { value: SalesPreset; label: string }[] = [
  { value: "mtd", label: "Month to date" },
  { value: "last-month", label: "Last month" },
  { value: "last-30", label: "Last 30 days" },
  { value: "qtd", label: "Quarter to date" },
  { value: "ytd", label: "Year to date" },
  { value: "last-year", label: "Last year" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom range" },
];

// [from, to) in the browser's own local time (Chicago), null = open-ended.
// Worked out here rather than on the server, whose "midnight" is UTC.
function presetRange(preset: Exclude<SalesPreset, "custom">, now = new Date()): { from: Date | null; to: Date | null } {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case "mtd":
      return { from: new Date(y, m, 1), to: null };
    case "last-month":
      return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) };
    case "last-30":
      return { from: new Date(y, m, now.getDate() - 29), to: null };
    case "qtd":
      return { from: new Date(y, Math.floor(m / 3) * 3, 1), to: null };
    case "ytd":
      return { from: new Date(y, 0, 1), to: null };
    case "last-year":
      return { from: new Date(y - 1, 0, 1), to: new Date(y, 0, 1) };
    case "all":
      return { from: null, to: null };
  }
}

// "YYYY-MM-DD" from a date input, as local midnight (new Date("2026-09-01")
// would parse it as UTC midnight, the evening before in Chicago).
function parseDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatRange(from: Date | null, to: Date | null): string {
  if (!from && !to) return "All sales tracked by this app";
  const lastDay = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() - 1) : new Date();
  const full: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  if (!from) return `Through ${lastDay.toLocaleDateString(undefined, full)}`;
  if (toDateInput(from) === toDateInput(lastDay)) return from.toLocaleDateString(undefined, full);
  const sameYear = from.getFullYear() === lastDay.getFullYear();
  const start = from.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : full);
  return `${start} – ${lastDay.toLocaleDateString(undefined, full)}`;
}

function SalesSection({ isOwner, refreshKey }: { isOwner: boolean; refreshKey: number }) {
  const [preset, setPreset] = useState<SalesPreset>("mtd");
  const today = toDateInput(new Date());
  const [customFrom, setCustomFrom] = useState(() => toDateInput(presetRange("mtd").from!));
  const [customTo, setCustomTo] = useState(today);
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Custom: both ends inclusive on screen, so `to` is the day after the
  // picked end date. An incomplete or backwards pick just doesn't fetch.
  let range: { from: Date | null; to: Date | null } | null = null;
  let rangeError: string | null = null;
  if (preset === "custom") {
    const from = parseDateInput(customFrom);
    const end = parseDateInput(customTo);
    if (!from || !end) rangeError = "Pick both a start and an end date.";
    else if (from > end) rangeError = "The start date has to be on or before the end date.";
    else range = { from, to: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) };
  } else {
    range = presetRange(preset);
  }
  const fromIso = range?.from?.toISOString() ?? "";
  const toIso = range?.to?.toISOString() ?? "";
  const key = range ? `${fromIso}|${toIso}|${refreshKey}` : null;
  // Which request the numbers on screen came from; loading while that
  // doesn't match the current pick.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = key != null && loadedKey !== key;

  useEffect(() => {
    if (key == null) return;
    const params = new URLSearchParams();
    if (fromIso) params.set("from", fromIso);
    if (toIso) params.set("to", toIso);
    let cancelled = false;
    fetch(`/api/dashboard/sales?${params}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Couldn't load sales.");
        return data as SalesSummary;
      })
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load sales."))
      .finally(() => !cancelled && setLoadedKey(key));
    return () => {
      cancelled = true;
    };
  }, [key, fromIso, toIso]);

  return (
    <section>
      <SectionHeader
        title="Sales"
        description={range ? formatRange(range.from, range.to) : "Custom range"}
        action={
          <div className="w-44">
            <Select
              size="sm"
              value={preset}
              onChange={(e) => setPreset(e.target.value as SalesPreset)}
              aria-label="Sales date range"
            >
              {SALES_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
        }
      />
      {preset === "custom" && (
        <div className="mb-3 grid grid-cols-2 gap-3 sm:max-w-md">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">From</span>
            <Input
              size="sm"
              type="date"
              value={customFrom}
              max={today}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">To</span>
            <Input size="sm" type="date" value={customTo} max={today} onChange={(e) => setCustomTo(e.target.value)} />
          </label>
        </div>
      )}
      {(rangeError || error) && <p className="mb-3 text-sm font-medium text-danger">{rangeError ?? error}</p>}
      {summary ? (
        <div className={cn("grid grid-cols-2 gap-3 transition-opacity sm:grid-cols-3", loading && "opacity-50")}>
          <Stat label="Units sold" value={summary.units} />
          {summary.revenue != null && <Stat label="Revenue" value={summary.revenue} format="currency" />}
          {summary.fees != null && <Stat label="Fees" value={summary.fees} format="currency" />}
          {summary.shipping != null && <Stat label="Shipping" value={summary.shipping} format="currency" />}
          {summary.refunded != null && (
            <Stat label="Refunds" value={summary.refunded} format="currency" highlight={summary.refunded > 0} />
          )}
          {summary.profit != null && (
            <Stat
              label="Profit"
              value={summary.profit}
              format="currency"
              highlight={summary.units > 0 && summary.profit < 0}
            />
          )}
        </div>
      ) : (
        !error && <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {isOwner && (
        <p className="mt-2 text-xs text-muted-foreground">
          Only counts items scanned and listed through this app. Profit uses manifest COGS where available, $0 for
          anything with no manifest.
        </p>
      )}
    </section>
  );
}

function ExpiringItemCard({
  item,
  canManage,
  onChange,
}: {
  item: ExpiringListedItem;
  // False for an employee: they see the listing and its current
  // promotion/sale status, but can't change the price or promotions.
  canManage: boolean;
  onChange: (patch: Partial<ExpiringListedItem>) => void;
}) {
  const [discountMode, setDiscountMode] = useState<"percent" | "amount">("percent");
  const [discountValue, setDiscountValue] = useState("");
  const [bidPercentage, setBidPercentage] = useState("");
  const [markdownPercent, setMarkdownPercent] = useState("");
  const [acting, setActing] = useState<"discount" | "promote" | "bid" | "stop" | "markdown" | "stop-markdown" | null>(
    null
  );
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

  async function startMarkdown() {
    const value = Number(markdownPercent);
    if (!value || value < 1 || value > 80) return;
    if (
      !confirm(
        `Start a ${value}% off sale event on "${item.finalTitle ?? item.sku}"? Buyers will see the current price struck through next to the new discounted price on the live eBay listing.`
      )
    ) {
      return;
    }
    setActing("markdown");
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/markdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ percentOff: value }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Starting the sale event failed.");
      onChange({
        ebayMarkdownId: result.ebayMarkdownId,
        markdownPercentOff: result.markdownPercentOff,
        markdownEndsAt: result.markdownEndsAt,
      });
      setMarkdownPercent("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setActing(null);
    }
  }

  async function stopMarkdown() {
    if (!confirm(`End the sale event on "${item.finalTitle ?? item.sku}"? The listing stays live at its regular price.`)) {
      return;
    }
    setActing("stop-markdown");
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/markdown`, { method: "DELETE" });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Failed to end the sale event.");
      onChange({ ebayMarkdownId: null, markdownPercentOff: null, markdownEndsAt: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setActing(null);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium leading-snug text-foreground">{item.finalTitle ?? item.sku}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <Badge>Shelf {item.shelfLocation}</Badge>
            {item.livePrice != null ? (
              <span>
                {item.liveOriginalPrice != null && (
                  <span className="mr-1 line-through">${item.liveOriginalPrice.toFixed(2)}</span>
                )}
                <span className={cn("font-medium", item.liveOriginalPrice != null ? "text-success" : "text-foreground")}>
                  ${item.livePrice.toFixed(2)}
                </span>
              </span>
            ) : item.price != null ? (
              <span className="font-medium text-foreground">${item.price.toFixed(2)}</span>
            ) : (
              <span>no price</span>
            )}
            {ebayListingUrl(item) && (
              <a
                href={ebayListingUrl(item)!}
                target="_blank"
                rel="noreferrer"
                className="-my-2 inline-flex items-center gap-1 py-2 font-medium text-primary hover:underline"
              >
                View on eBay
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <Badge tone={urgent ? "danger" : "neutral"}>{days < 0 ? "Expired" : `${days}d left`}</Badge>
          <p className="mt-1 text-xs text-muted-foreground">{new Date(item.expirationDate).toLocaleDateString()}</p>
        </div>
      </div>

      {canManage ? (
        <div className="mt-4 grid gap-4 border-t border-border pt-4 md:grid-cols-3">
          <ActionGroup label="Discount">
            <div className="flex gap-2">
              {/* Width lives on the wrapper: form controls are w-full by
                  default (they fill whatever they're placed in), so a width
                  class on the control itself would just fight that. */}
              <div className="w-28 shrink-0">
                <Select
                  size="sm"
                  value={discountMode}
                  onChange={(e) => setDiscountMode(e.target.value as "percent" | "amount")}
                  aria-label="Discount type"
                >
                  <option value="percent">% off</option>
                  <option value="amount">$ off</option>
                </Select>
              </div>
              <Input
                size="sm"
                type="number"
                step="0.01"
                min={0}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                placeholder={discountMode === "percent" ? "15" : "5.00"}
                aria-label="Discount amount"
                className="min-w-0"
              />
              <Button size="md" onClick={applyDiscount} disabled={acting !== null || !discountValue} className="shrink-0">
                {acting === "discount" ? "Applying…" : "Apply"}
              </Button>
            </div>
          </ActionGroup>

          <ActionGroup
            label="Promote"
            status={item.ebayAdId ? <Badge tone="success">Promoted at {item.promotedBidPercentage}%</Badge> : undefined}
          >
            {item.ebayAdId ? (
              <div className="flex flex-wrap gap-2">
                <Input
                  size="sm"
                  type="number"
                  min={1}
                  max={100}
                  value={bidPercentage}
                  onChange={(e) => setBidPercentage(e.target.value)}
                  placeholder="new %"
                  aria-label="New bid percentage"
                  className="min-w-0 flex-1 basis-20"
                />
                <Button variant="outline" onClick={updateBid} disabled={acting !== null || !bidPercentage}>
                  {acting === "bid" ? "Updating…" : "Update bid"}
                </Button>
                <Button variant="danger-ghost" onClick={stopPromoting} disabled={acting !== null}>
                  {acting === "stop" ? "Stopping…" : "Stop"}
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  size="sm"
                  type="number"
                  min={1}
                  max={100}
                  value={bidPercentage}
                  onChange={(e) => setBidPercentage(e.target.value)}
                  placeholder="bid %"
                  aria-label="Bid percentage"
                  className="min-w-0"
                />
                <Button variant="outline" onClick={promote} disabled={acting !== null || !bidPercentage} className="shrink-0">
                  {acting === "promote" ? "Promoting…" : "Promote"}
                </Button>
              </div>
            )}
          </ActionGroup>

          <ActionGroup
            label="Sale event"
            status={
              item.ebayMarkdownId ? (
                <Badge tone="purple">
                  {item.markdownPercentOff}% off
                  {item.markdownEndsAt ? ` until ${new Date(item.markdownEndsAt).toLocaleDateString()}` : ""}
                </Badge>
              ) : undefined
            }
          >
            {item.ebayMarkdownId ? (
              <Button variant="danger-ghost" onClick={stopMarkdown} disabled={acting !== null}>
                {acting === "stop-markdown" ? "Ending…" : "End sale event"}
              </Button>
            ) : (
              <div className="flex gap-2">
                <Input
                  size="sm"
                  type="number"
                  min={1}
                  max={80}
                  value={markdownPercent}
                  onChange={(e) => setMarkdownPercent(e.target.value)}
                  placeholder="sale %"
                  aria-label="Sale percentage off"
                  className="min-w-0"
                />
                <Button
                  variant="outline"
                  onClick={startMarkdown}
                  disabled={acting !== null || !markdownPercent}
                  className="shrink-0"
                >
                  {acting === "markdown" ? "Starting…" : "Start sale"}
                </Button>
              </div>
            )}
          </ActionGroup>
        </div>
      ) : (
        (item.ebayAdId || item.ebayMarkdownId) && (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
            {item.ebayAdId && <Badge tone="success">Promoted at {item.promotedBidPercentage}%</Badge>}
            {item.ebayMarkdownId && (
              <Badge tone="purple">
                Sale: {item.markdownPercentOff}% off
                {item.markdownEndsAt ? ` until ${new Date(item.markdownEndsAt).toLocaleDateString()}` : ""}
              </Badge>
            )}
          </div>
        )
      )}

      {canManage && (error || item.ebayPromoteError || item.ebayMarkdownError) && (
        <p className="mt-3 text-sm text-danger">{error ?? item.ebayPromoteError ?? item.ebayMarkdownError}</p>
      )}
    </Card>
  );
}

// One labelled column of the expiring-item action row — stacks on the
// scanner's narrow screen, sits three-across from md up.
function ActionGroup({ label, status, children }: { label: string; status?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex min-h-5 flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        {status}
      </div>
      {children}
    </div>
  );
}
