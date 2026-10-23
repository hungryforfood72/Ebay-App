"use client";

import { Stat } from "@/components/Stat";
import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// The eBay listing backup (src/lib/listingBackup.ts): what's saved, and the
// restore onto a new eBay account if the old one is ever lost.

type RunResult = {
  at: string;
  ok: boolean;
  error?: string;
  sellerUserId?: string | null;
  live?: number;
  added?: number;
  ended?: number;
  detailsFetched?: number;
  detailsLeft?: number;
  photosSaved?: number;
  failures?: number;
  warning?: string;
};

type Account = {
  sellerUserId: string | null;
  live: number;
  units: number;
  value: number;
  madeInApp: number;
  madeOnEbay: number;
  complete: number;
  missingDetails: number;
  missingPhotos: number;
  restored: number;
  restoreErrors: number;
};

type Summary = {
  lastRun: RunResult | null;
  accounts: Account[];
  ended: number;
  restoreFailures: { listingId: string; title: string; error: string }[];
};

type Preflight = {
  connectedSellerId: string | null;
  fromAccounts: { sellerUserId: string | null; waiting: number; restored: number; failed: number }[];
  error?: string;
};

type RestoreBatch = {
  restored: number;
  failed: { listingId: string; title: string; error: string }[];
  remaining: number;
  connectedSellerId: string;
};

function money(n: number) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function EbayBackupPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/ebay-backup")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Couldn't load the backup.");
        return data as Summary;
      })
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        setLoadError(null);
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "Couldn't load the backup."));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function backUpNow(acceptDrop = false) {
    setRunning(true);
    setRunMessage(null);
    const res = await fetch("/api/settings/ebay-backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acceptDrop }),
    });
    const data = await res.json();
    setRunning(false);
    if (!res.ok) setRunMessage(data.error ?? "Backup failed.");
    else if (!data.ok) setRunMessage(`Backup failed: ${data.error}`);
    else
      setRunMessage(
        `Done. ${data.live} live listings checked, ${data.added} new, ${data.detailsFetched} pulled in full, ${data.photosSaved} photos copied.` +
          (data.detailsLeft ? ` ${data.detailsLeft} still to pull; run it again or let the hourly backup finish them.` : "")
      );
    load();
  }

  const lastRun = summary?.lastRun;
  const current = summary?.accounts.find((a) => a.sellerUserId === lastRun?.sellerUserId) ?? summary?.accounts[0];

  return (
    <AppShell
      width="medium"
      title="eBay listing backup"
      subtitle="A copy of every live eBay listing, so a new account can be connected and everything put back up."
      actions={
        <a href="/api/settings/ebay-backup/export" className={buttonClasses({ variant: "outline", size: "sm" })}>
          <Download className="size-4" aria-hidden />
          Download
        </a>
      }
    >
      <div className="flex flex-col gap-6">
        {loadError && <Alert tone="danger">{loadError}</Alert>}
        {!summary && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}

        {summary && (
          <>
            {lastRun?.warning && (
              <Alert
                tone="warning"
                title="Listings disappeared from eBay"
                action={
                  <Button size="sm" variant="outline" onClick={() => backUpNow(true)} disabled={running}>
                    I ended them myself, update the backup
                  </Button>
                }
              >
                {lastRun.warning}
              </Alert>
            )}
            {lastRun && !lastRun.ok && (
              <Alert tone="danger" title="Last backup couldn't reach eBay">
                {lastRun.error} The listings already saved are untouched.
              </Alert>
            )}

            <Card>
              <SectionHeader
                title={current?.sellerUserId ? `Account: ${current.sellerUserId}` : "Backup"}
                description={
                  lastRun
                    ? `Last backup ${new Date(lastRun.at).toLocaleString()}. Runs every hour on its own.`
                    : "No backup has run yet."
                }
                action={
                  <Button size="sm" onClick={() => backUpNow()} disabled={running}>
                    {running ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                    {running ? "Backing up…" : "Back up now"}
                  </Button>
                }
              />
              {current ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Live listings saved" value={current.live} />
                  <Stat label="Units" value={current.units} />
                  <Stat label="At list price" value={money(current.value)} />
                  <Stat
                    label="Ready to restore"
                    value={`${current.complete}/${current.live}`}
                    highlight={current.complete < current.live && lastRun?.detailsLeft === 0}
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing saved yet. Hit &quot;Back up now&quot;.</p>
              )}
              {current && (
                <ul className="mt-4 flex flex-col gap-1 text-sm text-muted-foreground">
                  <li>
                    {current.madeInApp} made in the app (their photos and details were already here) and {current.madeOnEbay} made
                    straight on eBay (photos copied to the app&apos;s photo storage).
                  </li>
                  {current.missingDetails > 0 && <li>{current.missingDetails} not pulled in full yet; the hourly backup gets them.</li>}
                  {current.missingPhotos > 0 && <li>{current.missingPhotos} still missing photo copies; retried every hour.</li>}
                  <li>Each listing&apos;s full details are re-checked every 5 days, and right away when its title changes.</li>
                </ul>
              )}
              {runMessage && <p className="mt-3 text-sm text-foreground">{runMessage}</p>}
            </Card>

            <RestoreCard summary={summary} onChange={load} />
          </>
        )}
      </div>
    </AppShell>
  );
}

function RestoreCard({ summary, onChange }: { summary: Summary; onChange: () => void }) {
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState<{ restored: number; failed: number; remaining: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  async function check() {
    setChecking(true);
    setError(null);
    const res = await fetch("/api/settings/ebay-backup/restore");
    setPreflight(await res.json());
    setChecking(false);
  }

  const waiting = preflight?.fromAccounts.reduce((s, a) => s + a.waiting, 0) ?? 0;
  const fromNames = preflight?.fromAccounts.map((a) => a.sellerUserId ?? "unknown").join(", ");

  async function restore(retryFailed: boolean) {
    if (
      !confirm(
        `Re-list ${waiting} listings from ${fromNames} onto ${preflight?.connectedSellerId}?\n\nOnly do this if the old account is gone. If it's still selling, every item would be listed twice.`
      )
    )
      return;
    stopRef.current = false;
    setRestoring(true);
    setError(null);
    const totals = { restored: 0, failed: 0, remaining: waiting };
    setProgress({ ...totals });
    let retry = retryFailed;
    while (!stopRef.current) {
      const res = await fetch("/api/settings/ebay-backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retryFailed: retry }),
      });
      const data = (await res.json()) as RestoreBatch & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Restore failed.");
        break;
      }
      // Failures are retried once at most (on the first batch, when asked).
      retry = false;
      totals.restored += data.restored;
      totals.failed += data.failed.length;
      totals.remaining = data.remaining;
      setProgress({ ...totals });
      if (data.remaining === 0 || (data.restored === 0 && data.failed.length === 0)) break;
    }
    setRestoring(false);
    onChange();
    check();
  }

  const sameAccount = preflight && preflight.fromAccounts.length === 0;

  return (
    <Card>
      <SectionHeader
        title="Move listings to a new eBay account"
        description="Only for when the current eBay account is lost. Everything in the backup gets listed on whichever account is connected."
      />
      <ol className="mb-4 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-foreground">
        <li>
          On the new eBay account, create shipping, payment and return policies (Seller Hub, Account, Business policies), then put
          their IDs in Vercel: <code className="text-xs">EBAY_PRODUCTION_FULFILLMENT_POLICY_ID</code>,{" "}
          <code className="text-xs">EBAY_PRODUCTION_PAYMENT_POLICY_ID</code>,{" "}
          <code className="text-xs">EBAY_PRODUCTION_RETURN_POLICY_ID</code>, and redeploy.
        </li>
        <li>
          <Link href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
            Settings
          </Link>
          : disconnect eBay and connect the new account.
        </li>
        <li>
          Set up the ship-from location on it: <code className="text-xs">npx tsx scripts/ebay-setup-location.ts</code>.
        </li>
        <li>Check below, then restore. Items from the app keep their sales history, bins and Shopify listing.</li>
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={check} disabled={checking || restoring}>
          {checking ? "Checking…" : "Check connected account"}
        </Button>
        {preflight && !preflight.error && waiting > 0 && (
          <Button size="sm" variant="warning" onClick={() => restore(false)} disabled={restoring}>
            {restoring ? "Restoring…" : `Restore ${waiting} listings to ${preflight.connectedSellerId}`}
          </Button>
        )}
        {restoring && (
          <Button size="sm" variant="ghost" onClick={() => (stopRef.current = true)}>
            Stop after this batch
          </Button>
        )}
      </div>

      {preflight?.error && (
        <Alert tone="danger" className="mt-3">
          Couldn&apos;t reach eBay: {preflight.error}
        </Alert>
      )}
      {preflight && !preflight.error && (
        <div className="mt-3 text-sm text-foreground">
          <p>
            Connected now: <Badge tone="primary">{preflight.connectedSellerId}</Badge>
          </p>
          {sameAccount && (
            <p className="mt-2 text-muted-foreground">
              Every backed-up listing is from this same account, so there&apos;s nothing to move. This is what it should say while
              the account is fine.
            </p>
          )}
          {preflight.fromAccounts.map((a) => (
            <p key={a.sellerUserId ?? "unknown"} className="mt-1">
              From {a.sellerUserId ?? "unknown account"}: {a.waiting} waiting, {a.restored} restored
              {a.failed > 0 ? `, ${a.failed} failed` : ""}.
            </p>
          ))}
        </div>
      )}

      {progress && (
        <p className="mt-3 text-sm font-medium text-foreground">
          {progress.restored} re-listed, {progress.failed} failed, {progress.remaining} to go.
        </p>
      )}
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}

      {summary.restoreFailures.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-foreground">Didn&apos;t go up ({summary.restoreFailures.length})</p>
            {preflight && !preflight.error && !restoring && (
              <Button size="sm" variant="outline" onClick={() => restore(true)}>
                Retry these
              </Button>
            )}
          </div>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border text-sm">
            {summary.restoreFailures.map((f) => (
              <li key={f.listingId} className="p-3">
                <p className="font-medium text-foreground">{f.title}</p>
                <p className="mt-0.5 text-xs text-danger">{f.error}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
