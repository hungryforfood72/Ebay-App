"use client";

import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { FetchedLocationBadge } from "@/components/LocationBadge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { CheckboxRow, Field, Input, Select, Textarea } from "@/components/ui/Input";
import {
  Check,
  Download,
  ExternalLink,
  Package,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { describeBreakdown, type ExpirationBatch } from "@/lib/expirationBreakdown";
import { ebayDescriptionHtml } from "@/lib/listingDescription";
import { priceOutcome } from "@/lib/offerMath";
import type { RetailCheckLine, RetailCheckRow } from "@/lib/retailCheck";
import { labelForWeight } from "@/lib/shippingZone";
import Link from "next/link";
import { useEffect, useRef, useState, type ComponentProps } from "react";

type CategoryRule = {
  id: string;
  keyword: string;
  categoryId: string;
  categoryName: string;
};

type BundleComponent = {
  upc: string;
  quantity: number;
  photoUrls?: string[] | null;
  name?: string | null;
  expirationDate?: string | null;
};

type Item = {
  id: string;
  sku: string;
  // Warehouse items only: units in bins vs units to bin. Held in review
  // until they match (src/lib/warehouse/binGate.ts).
  binProgress?: { inBins: number; needed: number };
  status: "pending_review" | "ready" | "exported" | "listed";
  upc: string | null;
  quantity: number;
  isMultipack: boolean;
  packSize: number | null;
  expirationDate: string | null;
  // Units with different dates (oldest first); expirationDate is the oldest.
  expirationBreakdown: ExpirationBatch[] | null;
  shelfLocation: string;
  photoUrls: string[];
  isBundle: boolean;
  bundleComponents: BundleComponent[] | null;
  finalTitle: string | null;
  finalDescription: string | null;
  aiTitle: string | null;
  aiDescription: string | null;
  price: string | null;
  categoryId: string | null;
  condition: string | null;
  compNotes: string | null;
  itemSpecifics: Record<string, string> | null;
  chargeForShipping: boolean;
  boxSize: string | null;
  weightLbs: number | null;
  weightOz: number | null;
  localPickupOnly: boolean;
  // Shopify & Whatnot only: never listed on eBay (see Item.shopifyOnly).
  shopifyOnly: boolean;
  shopifyError: string | null;
  ebayListingId: string | null;
  ebayPublishError: string | null;
  ebayEnvironment: string | null;
};

type BoxSize = { id: string; label: string };

export default function ReviewPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [rules, setRules] = useState<CategoryRule[]>([]);
  const [boxSizes, setBoxSizes] = useState<BoxSize[]>([]);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the publish route fixed on its own (a blocked word, a missing or
  // rejected item specific) on items that then went live, so nothing
  // changes on a listing without Cristian seeing it.
  const [autoFixNotes, setAutoFixNotes] = useState<string[]>([]);
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [bulkPublishing, setBulkPublishing] = useState(false);

  // The 10-second refresh below used to replace every item with whatever the
  // server had when the request went out. An edit still saving (or made
  // after that request left) came back as the old value, while the inputs,
  // which don't re-read from state, kept showing what was typed or picked.
  // "Mark ready" then checked the stale copy: "needs a condition" with New
  // showing on screen (Cristian, 2026-09-29). So each edit is remembered
  // until the server copy has had a chance to catch up, and laid back over
  // anything a refresh brings in.
  const localEdits = useRef(new Map<string, { seq: number; fields: Partial<Item> }>());
  // Increments on every edit; a refresh remembers where it was when it left.
  const editSeq = useRef(0);
  const pendingSaves = useRef(new Map<string, Promise<unknown>>());
  const itemsRef = useRef<Item[] | null>(null);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  async function load() {
    const startedSeq = editSeq.current;
    const [itemsRes, rulesRes, boxSizesRes] = await Promise.all([
      fetch("/api/items"),
      fetch("/api/category-rules"),
      fetch("/api/box-sizes"),
    ]);
    const fetched: Item[] = await itemsRes.json();
    setItems(
      fetched.map((f) => {
        const edit = localEdits.current.get(f.id);
        if (!edit) return f;
        if (edit.seq <= startedSeq && !pendingSaves.current.has(f.id)) {
          // Saved before this refresh asked for it: the server copy has it.
          localEdits.current.delete(f.id);
          return f;
        }
        return { ...f, ...edit.fields };
      })
    );
    setRules(await rulesRes.json());
    setBoxSizes(await boxSizesRes.json());
  }

  useEffect(() => {
    // Initial data load on mount, not a reaction to state we own.
    load();
    // Items scanned on the phone get their draft + category filled in by a
    // background job (see api/items POST) — poll so they show up here
    // without a manual refresh while that's still running.
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, []);

  async function saveRule(keyword: string, categoryId: string, categoryName: string) {
    const res = await fetch("/api/category-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, categoryId, categoryName }),
    });
    const rule: CategoryRule = await res.json();
    setRules((prev) => [...prev.filter((r) => r.keyword !== rule.keyword), rule]);
  }

  async function updateItem(id: string, data: Partial<Item>) {
    const previous = localEdits.current.get(id);
    editSeq.current += 1;
    localEdits.current.set(id, { seq: editSeq.current, fields: { ...previous?.fields, ...data } });
    setItems(
      (prev) =>
        prev?.map((i) => (i.id === id ? { ...i, ...data } : i)) ?? prev
    );
    // Chained per item so saves land in the order they were made.
    const save = (pendingSaves.current.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        fetch(`/api/items/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        })
      );
    pendingSaves.current.set(id, save);
    try {
      await save;
    } finally {
      if (pendingSaves.current.get(id) === save) pendingSaves.current.delete(id);
    }
  }

  async function deleteItem(item: Item) {
    if (!confirm(`Delete "${item.finalTitle ?? item.upc ?? item.sku}"? This can't be undone.`)) {
      return;
    }
    setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? prev);
    await fetch(`/api/items/${item.id}`, { method: "DELETE" });
  }

  async function generateDraft(item: Item) {
    setDraftingId(item.id);
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/draft`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Draft generation failed.");
      }
      const updated: Item = await res.json();
      setItems((prev) => prev?.map((i) => (i.id === item.id ? updated : i)) ?? prev);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setDraftingId(null);
    }
  }

  async function markReady(clicked: Item) {
    // Let any save still going for this item (a field just changed or
    // blurred) finish, then check the newest values, not the copy this
    // button was rendered with.
    await pendingSaves.current.get(clicked.id)?.catch(() => {});
    const item = itemsRef.current?.find((i) => i.id === clicked.id) ?? clicked;
    const label = item.upc ?? item.sku;
    if (!item.finalTitle?.trim() || !item.price) {
      setError(`"${label}" needs a title and price before it can go ready.`);
      return;
    }
    // Category lookup is a manual step (Search Category button) and can also
    // come up empty on its own — a real upload failed with "missing required
    // input tag <Item.PrimaryCategory.CategoryID>" for an item that reached
    // export with no category set.
    if (!item.categoryId) {
      setError(`"${label}" needs a category before it can go ready.`);
      return;
    }
    // Condition is required by nearly every eBay category — a real upload
    // failed with "Item condition is required for this category" for an
    // item that reached export with condition still unset.
    if (!item.condition) {
      setError(`"${label}" needs a condition before it can go ready.`);
      return;
    }
    // eBay's shipping engine requires actual package weight even on free
    // shipping — a real upload failed with "package weight is not valid or
    // is missing" for an item with no weight set.
    if (!item.localPickupOnly && !item.weightLbs && !item.weightOz) {
      setError(`"${label}" needs a package weight before it can go ready.`);
      return;
    }
    // Warehouse items wait in review until the binning station has put
    // every unit in a bin, so nothing sells while it's loose on the table.
    // The server refuses it too; this just says why up front.
    const hold = binHold(item);
    if (hold) {
      setError(`"${label}": ${hold}`);
      return;
    }
    setError(null);
    await updateItem(item.id, { status: "ready" });
  }

  // Distinct from "Mark ready" — this is the actual, not-cleanly-undoable
  // publish to eBay via the real Inventory API (or, for a Shopify & Whatnot
  // only item, to the Shopify store instead). Errors (a bad category ID,
  // a missing business policy, etc.) come back from the store's own
  // validation and are shown inline on the item rather than swallowed.
  // Returns whether it succeeded, so publishAllToEbay can tally results
  // across a batch.
  async function publishToEbay(item: Item): Promise<boolean> {
    setPublishingId(item.id);
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/${item.shopifyOnly ? "publish-to-shopify" : "publish-to-ebay"}`, {
        method: "POST",
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error ?? "Publish failed.");
      }
      const { autoFixes, ...updated } = result as Item & { autoFixes?: string[] };
      if (autoFixes?.length) {
        setAutoFixNotes((prev) => [...prev, `${updated.finalTitle ?? item.finalTitle}: ${autoFixes.join(" ")}`]);
      }
      setItems((prev) => prev?.map((i) => (i.id === item.id ? updated : i)) ?? prev);
      return true;
    } catch (e) {
      await load();
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    } finally {
      setPublishingId(null);
    }
  }

  // Runs publishToEbay one item at a time (not in parallel — keeps each
  // item's inline error/progress state legible, and avoids hammering eBay
  // with a burst of simultaneous requests) over every currently-ready item.
  // Each one still goes through the same review-then-publish path as a
  // single click — this is a convenience over repeating that click, not a
  // way to skip the review step, since every item here already had its
  // fields confirmed by hand to reach "ready" in the first place.
  async function publishAllToEbay() {
    if (ready.length === 0) return;
    if (
      !confirm(
        `Publish all ${ready.length} ready item(s) now? This creates real, live listings (on eBay, or on Shopify & Whatnot for the Shopify-only ones) and isn't easily undone.`
      )
    ) {
      return;
    }
    setBulkPublishing(true);
    const batch = [...ready];
    let succeeded = 0;
    const failed: string[] = [];
    for (const item of batch) {
      const ok = await publishToEbay(item);
      if (ok) succeeded++;
      else failed.push(item.finalTitle ?? item.sku);
    }
    setBulkPublishing(false);
    setError(
      failed.length === 0
        ? null
        : `Published ${succeeded} of ${batch.length}. Failed: ${failed.join(", ")} — see the error on each item below.`
    );
  }

  async function exportReady() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Export failed.");
      }
      const skipped = Number(res.headers.get("X-Skipped-Incomplete") ?? "0");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ebay-export.csv";
      a.click();
      URL.revokeObjectURL(url);
      load();
      if (skipped > 0) {
        setError(
          `Exported the rest, but skipped ${skipped} item${skipped === 1 ? "" : "s"} missing a category or condition — still marked "ready", fix and re-export.`
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setExporting(false);
    }
  }

  if (!items) {
    return (
      <AppShell title="Review queue">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    );
  }

  const pending = items.filter((i) => i.status === "pending_review");
  const ready = items.filter((i) => i.status === "ready");
  const exported = items.filter((i) => i.status === "exported");
  const listed = items.filter((i) => i.status === "listed");

  return (
    <AppShell
      width="full"
      title="Review queue"
      subtitle={`${pending.length} waiting on review · ${ready.length} ready to list`}
      actions={
        <Button variant="outline" onClick={exportReady} disabled={exporting || ready.length === 0}>
          <Download className="size-4" aria-hidden />
          {exporting ? "Exporting…" : "Download CSV for eBay"}
        </Button>
      }
    >
      <div className="flex flex-col gap-8">
        {error && <Alert tone="danger">{error}</Alert>}
        {autoFixNotes.length > 0 && (
          <Alert tone="info">
            <p className="font-medium">Fixed automatically, then published:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {autoFixNotes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
            <button type="button" className="mt-2 text-sm underline" onClick={() => setAutoFixNotes([])}>
              Dismiss
            </button>
          </Alert>
        )}

        <section>
          <SectionHeader
            title="Pending review"
            action={<Badge tone={pending.length > 0 ? "warning" : "neutral"}>{pending.length}</Badge>}
          />
          <div className="flex flex-col gap-4">
            {pending.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                rules={rules}
                boxSizes={boxSizes}
                onChange={(data) => updateItem(item.id, data)}
                onMarkReady={() => markReady(item)}
                onGenerateDraft={() => generateDraft(item)}
                onSaveRule={saveRule}
                onDelete={() => deleteItem(item)}
                drafting={draftingId === item.id}
              />
            ))}
            {pending.length === 0 && (
              <Card>
                <p className="text-sm text-muted-foreground">Nothing waiting on review.</p>
              </Card>
            )}
          </div>
        </section>

        <RetailCheckSection />

        <section>
          <SectionHeader
            title="Ready to list"
            action={
              ready.length > 0 ? (
                <Button size="sm" onClick={publishAllToEbay} disabled={bulkPublishing || publishingId !== null}>
                  <Send className="size-4" aria-hidden />
                  {bulkPublishing ? "Publishing all…" : `Publish all ${ready.length}`}
                </Button>
              ) : (
                <Badge>0</Badge>
              )
            }
          />
          {ready.length === 0 ? (
            <Card>
              <p className="text-sm text-muted-foreground">Nothing marked ready yet.</p>
            </Card>
          ) : (
            <Card padded={false} className="divide-y divide-border">
              {ready.map((item) => (
                <div key={item.id} className="flex flex-col gap-2 p-3 sm:p-4">
                  <div className="flex items-center gap-3">
                    <Thumb src={item.photoUrls[0]} />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-medium text-foreground">{item.finalTitle}</p>
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold tabular-nums text-foreground">
                        ${item.price}
                        {item.shopifyOnly && <Badge>Shopify &amp; Whatnot only</Badge>}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => publishToEbay(item)}
                      disabled={bulkPublishing || publishingId === item.id}
                      className="shrink-0"
                    >
                      {publishingId === item.id ? "Publishing…" : "Publish"}
                    </Button>
                  </div>
                  {(item.shopifyOnly ? item.shopifyError : item.ebayPublishError) && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                      <p className="min-w-0 flex-1">
                        {item.shopifyOnly ? "Shopify" : "eBay"} rejected this:{" "}
                        {item.shopifyOnly ? item.shopifyError : item.ebayPublishError}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => updateItem(item.id, { status: "pending_review" })}
                        disabled={bulkPublishing || publishingId === item.id}
                      >
                        Back to review
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </Card>
          )}
        </section>

        {listed.length > 0 && (
          <section>
            <SectionHeader title="Listed" action={<Badge tone="success">{listed.length}</Badge>} />
            <Card padded={false} className="divide-y divide-border">
              {listed.map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate text-foreground">{item.finalTitle}</span>
                  {item.shopifyOnly && <Badge>Shopify &amp; Whatnot</Badge>}
                  {item.ebayListingId && (
                    <a
                      href={
                        item.ebayEnvironment === "production"
                          ? `https://www.ebay.com/itm/${item.ebayListingId}`
                          : `https://sandbox.ebay.com/itm/${item.ebayListingId}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="-my-2 inline-flex shrink-0 items-center gap-1 py-2 font-medium text-primary hover:underline"
                    >
                      View
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  )}
                </div>
              ))}
            </Card>
          </section>
        )}

        {exported.length > 0 && (
          <section>
            <SectionHeader title="Exported" action={<Badge>{exported.length}</Badge>} />
            <Card padded={false} className="divide-y divide-border">
              {exported.map((item) => (
                <div key={item.id} className="px-4 py-2.5 text-sm">
                  <p className="truncate text-foreground">{item.finalTitle}</p>
                  <p className="text-xs text-muted-foreground">SKU {item.sku}</p>
                </div>
              ))}
            </Card>
          </section>
        )}
      </div>
    </AppShell>
  );
}

function Thumb({ src, size = "md" }: { src: string | undefined; size?: "sm" | "md" }) {
  const box = size === "sm" ? "size-8" : "size-12";
  return src ? (
    <img src={src} alt="" className={cn(box, "shrink-0 rounded-lg border border-border object-cover")} />
  ) : (
    <span className={cn(box, "grid shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground")}>
      <Package className="size-5" aria-hidden />
    </span>
  );
}

type ProfitBasis = {
  unitCost: number | null;
  typicalLabel: number;
  promotedPercent: number | null;
  targetReturnPct: number;
};

// Profit on one sale at the price in the box: eBay's fees (plus the
// Promoted Listings rate if it's promoted), a label for the weight entered
// (free shipping, so the label is ours), and what the item cost off its
// manifest. Same math as the offer tools (priceOutcome). An estimate: the
// real label depends on the buyer's zone. Red = loses money, yellow = makes
// money but under his target return on item cost (35%, the bar he lists
// at), green = clears it.
function ProfitEstimate({
  price,
  basis,
  localPickupOnly,
  weightLbs,
}: {
  price: number;
  basis: ProfitBasis;
  localPickupOnly: boolean;
  weightLbs: number | null;
}) {
  if (!(price > 0)) {
    return <span className="text-muted-foreground">Enter a price to see estimated profit.</span>;
  }
  const label = localPickupOnly ? 0 : weightLbs != null ? labelForWeight(basis.typicalLabel, weightLbs) : basis.typicalLabel;
  const { fees, profit } = priceOutcome(
    { listPrice: price, unitCost: basis.unitCost, labelCost: label, promotedPercent: basis.promotedPercent },
    price
  );
  const returnPct = basis.unitCost != null && basis.unitCost > 0 ? (profit / basis.unitCost) * 100 : null;
  const underTarget = profit >= 0 && returnPct != null && returnPct < basis.targetReturnPct;
  const parts = [
    `$${fees.toFixed(2)} fees${basis.promotedPercent ? ` (incl. ${basis.promotedPercent}% promo)` : ""}`,
    localPickupOnly ? "no label (pickup)" : `~$${label.toFixed(2)} label${weightLbs == null ? " (no weight yet)" : ""}`,
    basis.unitCost != null ? `$${basis.unitCost.toFixed(2)} item cost` : "no item cost on file",
  ];
  return (
    <span className="text-foreground">
      Est. profit at ${price.toFixed(2)}:{" "}
      <strong className={profit < 0 ? "text-danger" : underTarget ? "text-warning" : "text-success"}>
        {profit < 0 ? "-" : ""}${Math.abs(profit).toFixed(2)}
        {returnPct != null && ` (${Math.round(returnPct)}% ROI)`}
      </strong>
      <span className="text-muted-foreground"> after {parts.join(", ")}</span>
      {underTarget && (
        <span className="block text-warning">Under your {basis.targetReturnPct}% target, consider a higher price.</span>
      )}
    </span>
  );
}

// Why a warehouse item can't be marked ready yet, or null if it can.
function binHold(item: Item): string | null {
  const p = item.binProgress;
  if (!p || p.inBins >= p.needed) return null;
  return p.inBins === 0
    ? "No bin assigned yet. Scan its labels into a bin at the binning station first."
    : `Only ${p.inBins} of ${p.needed} units are in a bin. Scan the rest into a bin first.`;
}

function binHoldBadge(item: Item): string {
  const p = item.binProgress!;
  return p.inBins === 0 ? "In review · no bin assigned yet" : `In review · ${p.inBins} of ${p.needed} in bins`;
}

function ItemCard({
  item,
  rules,
  boxSizes,
  onChange,
  onMarkReady,
  onGenerateDraft,
  onSaveRule,
  onDelete,
  drafting,
}: {
  item: Item;
  rules: CategoryRule[];
  boxSizes: BoxSize[];
  onChange: (data: Partial<Item>) => void;
  onMarkReady: () => void;
  onGenerateDraft: () => void;
  onSaveRule: (keyword: string, categoryId: string, categoryName: string) => void;
  onDelete: () => void;
  drafting: boolean;
}) {
  const [ruleKeyword, setRuleKeyword] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const [titleLength, setTitleLength] = useState((item.finalTitle ?? "").length);
  useEffect(() => {
    // Resync the character counter when a new AI draft (or an external
    // update from polling) replaces the title out from under the user —
    // the title input itself is uncontrolled, so this is the one place that
    // needs to track the prop directly.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitleLength((item.finalTitle ?? "").length);
  }, [item.finalTitle]);
  const [newSpecKey, setNewSpecKey] = useState("");
  const [newSpecValue, setNewSpecValue] = useState("");
  const [searchingCategory, setSearchingCategory] = useState(false);
  const [catQuery, setCatQuery] = useState("");
  const [catResults, setCatResults] = useState<
    { id: string; name: string; path: string }[]
  >([]);

  useEffect(() => {
    if (catQuery.trim().length < 2) {
      // Clearing stale results when the query is cleared/too short, not a
      // reaction to state we own beyond catQuery itself.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCatResults([]);
      return;
    }
    const handle = setTimeout(() => {
      fetch(`/api/ebay-categories/search?q=${encodeURIComponent(catQuery.trim())}`)
        .then((r) => r.json())
        .then(setCatResults)
        .catch(() => setCatResults([]));
    }, 300);
    return () => clearTimeout(handle);
  }, [catQuery]);

  function updateSpecific(key: string, value: string) {
    const next = { ...(item.itemSpecifics ?? {}) };
    if (value.trim()) {
      next[key] = value.trim();
    } else {
      delete next[key];
    }
    onChange({ itemSpecifics: next });
  }

  function removeSpecific(key: string) {
    const next = { ...(item.itemSpecifics ?? {}) };
    delete next[key];
    onChange({ itemSpecifics: next });
  }
  const [categorySearchResult, setCategorySearchResult] = useState<{
    categoryId: string | null;
    categoryName: string | null;
    sourceUrl: string | null;
    fromExistingRule?: boolean;
  } | null>(null);
  const [categorySearchError, setCategorySearchError] = useState<string | null>(null);
  const [priceResearching, setPriceResearching] = useState(false);
  const [priceResearchResult, setPriceResearchResult] = useState<{
    packSize?: number;
    // For the whole listing (unitRetail x packSize).
    retailPrice: number | null;
    unitRetail?: number | null;
    // Owner only (null for employees): what a sale costs besides eBay's
    // fees, for the profit line under the comps.
    profitBasis?: ProfitBasis | null;
  } | null>(null);
  // What's in the price box right now, so profit follows the typing instead
  // of waiting for the blur that saves it. null = the saved price.
  const [typedPrice, setTypedPrice] = useState<string | null>(null);
  const [priceResearchError, setPriceResearchError] = useState<string | null>(null);
  const priceResearchedFor = useRef<string | null>(null);
  // Owner fixing a wrong manifest retail right here (null = not editing).
  const [retailDraft, setRetailDraft] = useState<string | null>(null);
  const [retailSaving, setRetailSaving] = useState(false);

  async function saveRetail() {
    if (!retailDraft) return;
    setRetailSaving(true);
    try {
      const res = await fetch("/api/retail-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, unitRetail: Number(retailDraft) }),
      });
      if (!res.ok) {
        setPriceResearchError((await res.json().catch(() => ({}))).error ?? "Couldn't save the retail.");
        return;
      }
      setRetailDraft(null);
      await researchPrice();
    } finally {
      setRetailSaving(false);
    }
  }

  // Manifest retail and, for the owner, the profit line. Comps are no longer
  // pulled through eBay's API (its license bars using them to suggest
  // prices): the box links to eBay's own search instead, opened in the
  // browser, which is how Cristian checks them anyway (2026-10-18).
  async function researchPrice() {
    setPriceResearching(true);
    setPriceResearchError(null);
    setPriceResearchResult(null);
    try {
      const res = await fetch(`/api/items/${item.id}/price-research`);
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Couldn't load the retail price.");
      setPriceResearchResult(result);
    } catch (e) {
      setPriceResearchError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setPriceResearching(false);
    }
  }

  // Runs automatically once a UPC or title is available — no need to hit
  // the button. Keyed off item.id so it only fires once per item (a title
  // edit while comps are already shown shouldn't silently re-trigger a
  // fetch mid-edit).
  useEffect(() => {
    if (priceResearchedFor.current === item.id) return;
    if (!item.upc && !item.finalTitle && !item.aiTitle) return;
    priceResearchedFor.current = item.id;
    // Deferred rather than called directly — researchPrice's first line is
    // a setState call, and calling that synchronously from an effect body
    // triggers React's cascading-render warning.
    const timer = setTimeout(researchPrice, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.upc, item.finalTitle, item.aiTitle]);
  const [typedCategoryCheck, setTypedCategoryCheck] = useState<{
    id: string;
    name: string | null; // null means the ID wasn't found in eBay's category tree
  } | null>(null);

  // The "Category ID" field below is free text — nothing stops someone from
  // typing a UPC or other garbage into it by mistake. Confirm it against
  // eBay's real category tree right away rather than finding out only when
  // the bulk upload rejects the whole listing.
  async function checkTypedCategoryId(id: string) {
    if (!id) {
      setTypedCategoryCheck(null);
      return;
    }
    try {
      const res = await fetch(`/api/ebay-categories/search?id=${encodeURIComponent(id)}`);
      const category: { name: string } | null = await res.json();
      setTypedCategoryCheck({ id, name: category?.name ?? null });
    } catch {
      setTypedCategoryCheck(null);
    }
  }

  const titleText = (item.finalTitle ?? item.aiTitle ?? "").toLowerCase();
  const suggestion = titleText
    ? rules.find((r) => titleText.includes(r.keyword))
    : undefined;

  async function searchCategory() {
    setSearchingCategory(true);
    setCategorySearchError(null);
    setCategorySearchResult(null);
    try {
      const res = await fetch(`/api/items/${item.id}/category-lookup`, {
        method: "POST",
      });
      // A platform-level failure (e.g. the function got killed for running
      // too long) returns Vercel's own HTML/text error page, not our JSON —
      // don't let that surface as a raw "not valid JSON" parse error.
      let result: {
        categoryId?: string | null;
        categoryName?: string | null;
        sourceUrl?: string | null;
        fromExistingRule?: boolean;
        error?: string;
      };
      try {
        result = await res.json();
      } catch {
        throw new Error("Search timed out or failed. Try again.");
      }
      if (!res.ok) {
        throw new Error(result.error ?? "Search failed.");
      }
      // The server already applied it and (for a fresh AI search) saved it
      // as a rule for next time — just reflect that here.
      onChange({ categoryId: result.categoryId ?? null });
      setCategorySearchResult(
        result as { categoryId: string; categoryName: string; sourceUrl: string | null; fromExistingRule?: boolean }
      );
    } catch (e) {
      setCategorySearchError(e instanceof Error ? e.message : "Search failed. Try again.");
    } finally {
      setSearchingCategory(false);
    }
  }
  return (
    // overflow-clip, not hidden: hidden would stop the action bar sticking.
    <Card padded={false} className="overflow-clip">
      {/* On a PC the card uses the whole width in columns (Cristian,
          2026-10-25: no scrolling to reach Mark ready or the rest of one
          item): the listing text | price, condition, shipping | category,
          specifics. One column on the scanner, same order. */}
      <div className="flex flex-col gap-4 p-4 sm:p-5 lg:grid lg:grid-cols-2 lg:gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col">
        {/* Photos: a swipeable strip on the scanner, a row on desktop. */}
        {item.photoUrls.length > 0 && (
          <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            {item.photoUrls.map((url) => (
              <img
                key={url}
                src={url}
                alt=""
                className="size-24 shrink-0 rounded-lg border border-border object-cover sm:size-28"
              />
            ))}
          </div>
        )}

        <div className="mb-4 flex flex-wrap gap-1.5">
          {item.isBundle ? (
            <Badge tone="purple">Bundle · {item.bundleComponents?.length ?? 0} different items</Badge>
          ) : (
            <Badge className="tabular-nums">UPC {item.upc}</Badge>
          )}
          <Badge>
            {item.isBundle ? "Bundles available" : "Qty"} {item.quantity}
          </Badge>
          {item.isMultipack && <Badge tone="primary">Pack of {item.packSize}</Badge>}
          <FetchedLocationBadge itemId={item.id} shelfLocation={item.shelfLocation} />
          {binHold(item) && <Badge tone="warning">{binHoldBadge(item)}</Badge>}
          {item.expirationBreakdown ? (
            <Badge tone="warning">Exp {describeBreakdown(item.expirationBreakdown)}</Badge>
          ) : (
            item.expirationDate && (
              <Badge tone="warning">Exp {new Date(item.expirationDate).toLocaleDateString(undefined, { timeZone: "UTC" })}</Badge>
            )
          )}
        </div>

        {item.isBundle && item.bundleComponents && item.bundleComponents.length > 0 && (
          <div className="mb-4 rounded-lg bg-background p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bundle contents</p>
            <ul className="flex flex-col gap-1.5">
              {item.bundleComponents.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-foreground">
                  {c.photoUrls?.map((url) => (
                    <img key={url} src={url} alt="" className="size-7 rounded-md object-cover" />
                  ))}
                  <span>
                    {c.quantity}x {c.name ?? `UPC ${c.upc}`}
                    {c.expirationDate && (
                      <span className="text-muted-foreground">
                        {" "}
                        · exp {new Date(c.expirationDate).toLocaleDateString(undefined, { timeZone: "UTC" })}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button variant="outline" size="sm" onClick={onGenerateDraft} disabled={drafting}>
            <Sparkles className={cn("size-4", drafting && "animate-pulse")} aria-hidden />
            {drafting ? "Drafting…" : item.aiTitle ? "Regenerate AI draft" : "Generate AI draft"}
          </Button>
          {drafting && (
            <span className="text-xs text-muted-foreground">
              Looking up the UPC and asking Claude for a title/description…
            </span>
          )}
          {!drafting && !item.aiTitle && (
            <span className="text-xs text-muted-foreground">
              Drafts and categories start automatically when an item is scanned — give it a minute, or generate now.
            </span>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label htmlFor={`title-${item.id}`} className="text-sm font-medium text-foreground">
                Title
              </label>
              <span className={cn("text-xs tabular-nums", titleLength >= 80 ? "font-medium text-danger" : "text-muted-foreground")}>
                {titleLength}/80
              </span>
            </div>
            {/* Every field here is uncontrolled and saves on blur. Two rules
                keep a stale copy from overwriting newer data (confirmed
                2026-10-07: a description fixed on the server was put back by
                an open Review tab when the box lost focus): the key includes
                the saved value, so a change made elsewhere reloads the box,
                and blur only saves when the text actually changed. */}
            <Input
              id={`title-${item.id}`}
              key={`title-${item.id}-${item.finalTitle ?? ""}`}
              type="text"
              placeholder="Title"
              defaultValue={item.finalTitle ?? ""}
              maxLength={80}
              onChange={(e) => setTitleLength(e.target.value.length)}
              onBlur={(e) => {
                if (e.target.value !== (item.finalTitle ?? "")) onChange({ finalTitle: e.target.value });
              }}
            />
          </div>

          <Field label="Description">
            <Textarea
              key={`desc-${item.id}-${item.finalDescription ?? ""}`}
              placeholder="Description"
              defaultValue={item.finalDescription ?? ""}
              onBlur={(e) => {
                if (e.target.value !== (item.finalDescription ?? "")) onChange({ finalDescription: e.target.value });
              }}
              rows={4}
              className="lg:min-h-56"
            />
          </Field>
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowPreview((v) => !v)}
              className="text-xs font-medium text-primary hover:underline"
            >
              {showPreview ? "Hide eBay preview" : "Preview how it looks on eBay"}
            </button>
            {showPreview && (
              <>
                <p className="mt-1 text-xs text-muted-foreground">
                  Updates when you click out of the description box. Headings are short lines ending in &quot;:&quot;,
                  bullets start with &quot;- &quot;.
                </p>
                {/* Sandboxed: it's the exact HTML eBay gets (listingDescription.ts). */}
                <iframe
                  title="eBay description preview"
                  sandbox="allow-same-origin"
                  srcDoc={`<!doctype html><html><body style="margin:12px;background:#fff">${ebayDescriptionHtml(item)}</body></html>`}
                  className="mt-2 h-96 w-full rounded-lg border border-border bg-white"
                />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
            <div className="2xl:col-span-2">
              <Field label="Price">
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">
                    $
                  </span>
                  <Input
                    key={`price-${item.id}-${item.price ?? ""}`}
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    defaultValue={item.price ?? ""}
                    onChange={(e) => setTypedPrice(e.target.value)}
                    onBlur={(e) => {
                      setTypedPrice(null);
                      if (e.target.value === (item.price ?? "")) return;
                      if (e.target.value && item.price != null && Number(e.target.value) === Number(item.price)) return;
                      onChange({ price: e.target.value });
                    }}
                    onWheel={(e) => e.currentTarget.blur()}
                    className="pl-7"
                  />
                </div>
              </Field>
              <div className="mt-2 flex flex-col gap-1 rounded-lg bg-background p-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-muted-foreground">Check comps on eBay</span>
                  <span className="flex flex-wrap items-center gap-3">
                    {(() => {
                      // Title words find far more listings than the UPC (most
                      // sellers never fill it in); the UPC link is there for
                      // an exact match.
                      const query = item.finalTitle ?? item.aiTitle ?? item.upc ?? "";
                      const search = (q: string, sold: boolean) =>
                        `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}${sold ? "&LH_Sold=1&LH_Complete=1" : ""}`;
                      const link = "inline-flex items-center gap-1 font-medium text-primary hover:underline";
                      if (!query) return null;
                      return (
                        <>
                          <a href={search(query, true)} target="_blank" rel="noopener noreferrer" className={link}>
                            Sold <ExternalLink className="size-3.5" aria-hidden />
                          </a>
                          <a href={search(query, false)} target="_blank" rel="noopener noreferrer" className={link}>
                            Active <ExternalLink className="size-3.5" aria-hidden />
                          </a>
                          {item.upc && query !== item.upc && (
                            <a href={search(item.upc, true)} target="_blank" rel="noopener noreferrer" className={link}>
                              Sold by UPC <ExternalLink className="size-3.5" aria-hidden />
                            </a>
                          )}
                        </>
                      );
                    })()}
                  </span>
                </div>
                {priceResearching && <span className="text-muted-foreground">Loading retail…</span>}
                {priceResearchError && <span className="text-danger">{priceResearchError}</span>}
                {priceResearchResult?.retailPrice != null && (
                  <span className="text-foreground">
                    Manifest retail ${priceResearchResult.retailPrice.toFixed(2)}
                    {priceResearchResult.packSize && priceResearchResult.packSize > 1 && priceResearchResult.unitRetail != null && (
                      <span className="text-muted-foreground">
                        {` for ${priceResearchResult.packSize} ($${priceResearchResult.unitRetail.toFixed(2)} each)`}
                      </span>
                    )}
                    {priceResearchResult.profitBasis && item.upc && retailDraft == null && (
                      <button
                        type="button"
                        className="ml-2 text-xs text-primary underline"
                        onClick={() => setRetailDraft(String(priceResearchResult.unitRetail ?? ""))}
                      >
                        Fix retail
                      </button>
                    )}
                  </span>
                )}
                {retailDraft != null && (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Real retail for one:</span>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      className="w-28"
                      value={retailDraft}
                      onChange={(e) => setRetailDraft(e.target.value)}
                    />
                    <Button size="sm" onClick={saveRetail} disabled={retailSaving || !(Number(retailDraft) > 0)}>
                      {retailSaving ? "Saving…" : "Save"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRetailDraft(null)} disabled={retailSaving}>
                      Cancel
                    </Button>
                  </span>
                )}
                {priceResearchResult?.profitBasis && !item.shopifyOnly && (
                  <ProfitEstimate
                    price={Number(typedPrice ?? item.price ?? "")}
                    basis={priceResearchResult.profitBasis}
                    localPickupOnly={item.localPickupOnly}
                    weightLbs={
                      item.weightLbs || item.weightOz ? (item.weightLbs ?? 0) + (item.weightOz ?? 0) / 16 : null
                    }
                  />
                )}
              </div>
            </div>

            <Field label="Condition">
              <Select
                key={`cond-${item.id}-${item.condition ?? ""}`}
                defaultValue={item.condition ?? ""}
                onChange={(e) => onChange({ condition: e.target.value || null })}
              >
                <option value="">Select condition…</option>
                <option value="new">New</option>
                <option value="new_other">New (other)</option>
                <option value="used">Used</option>
                <option value="for_parts">For parts</option>
              </Select>
            </Field>

            <Field
              label={item.expirationBreakdown ? "Earliest expiration date" : "Expiration date"}
              hint={
                item.expirationBreakdown
                  ? `Units have different dates: ${describeBreakdown(item.expirationBreakdown)}. Changing this replaces them with one date.`
                  : "Some categories (lots of health & beauty) require it on eBay."
              }
            >
              <Input
                key={`exp-${item.id}-${item.expirationDate ?? ""}`}
                type="date"
                defaultValue={item.expirationDate ? item.expirationDate.slice(0, 10) : ""}
                onChange={(e) =>
                  onChange({
                    expirationDate: e.target.value || null,
                    ...(item.expirationBreakdown && item.expirationBreakdown[0].date !== e.target.value
                      ? { expirationBreakdown: null }
                      : {}),
                  })
                }
              />
            </Field>
          </div>

          {!item.isBundle && (
            <CheckboxRow
              label="Shopify & Whatnot only"
              description={
                item.shopifyOnly
                  ? "Won't be listed on eBay. Price it like eBay; the Shopify store takes its discount off, and the buyer pays shipping."
                  : "Skip eBay. For things that can't pay for an eBay label, since Shopify and Whatnot buyers pay their own shipping."
              }
              checked={item.shopifyOnly}
              onChange={(e) => onChange({ shopifyOnly: e.target.checked })}
            />
          )}

          <div className="rounded-lg border border-border p-3 sm:p-4">
            <p className="text-sm font-medium text-foreground">Shipping</p>
            <p className="mb-3 text-xs text-muted-foreground">
              {item.shopifyOnly
                ? "The buyer pays shipping on Shopify and Whatnot, worked out from this weight, so get it close."
                : item.localPickupOnly
                ? "Local pickup only: the buyer pays on eBay and picks it up. No label, so no weight or box needed."
                : "Free, USPS Ground Advantage. Weight/box matter either way — accurate numbers keep eBay's calculated cost (or your absorbed cost on free shipping) from defaulting high."}
            </p>
            {!item.shopifyOnly && (
            <CheckboxRow
              className="mb-3"
              label="Local pickup only"
              description="No shipping. For big, heavy or fragile items."
              checked={item.localPickupOnly}
              onChange={(e) => onChange({ localPickupOnly: e.target.checked })}
            />
            )}
            {!item.localPickupOnly && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_7rem_7rem]">
              <div className="col-span-2 sm:col-span-1">
                <Select
                  value={item.boxSize ?? ""}
                  onChange={(e) => onChange({ boxSize: e.target.value || null })}
                  aria-label="Box size"
                >
                  <option value="">Box size…</option>
                  {boxSizes.map((b) => (
                    <option key={b.id} value={b.label}>
                      {b.label}
                    </option>
                  ))}
                </Select>
                {boxSizes.length === 0 && (
                  <Link href="/settings" className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
                    Add box sizes in Settings
                  </Link>
                )}
              </div>
              <SuffixNumber
                key={`lbs-${item.id}-${item.weightLbs ?? ""}`}
                suffix="lb"
                min={0}
                defaultValue={item.weightLbs ?? ""}
                onBlur={(e) => {
                  const value = e.target.value ? Number(e.target.value) : null;
                  if (value !== item.weightLbs) onChange({ weightLbs: value });
                }}
              />
              <SuffixNumber
                key={`oz-${item.id}-${item.weightOz ?? ""}`}
                suffix="oz"
                min={0}
                max={15}
                defaultValue={item.weightOz ?? ""}
                onBlur={(e) => {
                  const value = e.target.value ? Number(e.target.value) : null;
                  if (value !== item.weightOz) onChange({ weightOz: value });
                }}
              />
            </div>
            )}
          </div>

      </div>

      <div className="flex min-w-0 flex-col gap-4">
          <div className="rounded-lg border border-border p-3 sm:p-4">
            <p className="mb-3 text-sm font-medium text-foreground">eBay category</p>
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <div>
                <Input
                  key={`cat-${item.id}-${item.categoryId ?? ""}`}
                  type="text"
                  inputMode="numeric"
                  placeholder="Category ID"
                  title="eBay category ID"
                  aria-label="eBay category ID"
                  defaultValue={item.categoryId ?? ""}
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value === (item.categoryId ?? "")) return;
                    onChange({ categoryId: value });
                    checkTypedCategoryId(value);
                  }}
                />
                {typedCategoryCheck && typedCategoryCheck.id === (item.categoryId ?? "") && (
                  <p
                    className={cn(
                      "mt-1.5 flex items-start gap-1 text-xs font-medium",
                      typedCategoryCheck.name ? "text-success" : "text-danger"
                    )}
                  >
                    {typedCategoryCheck.name ? (
                      <Check className="mt-px size-3.5 shrink-0" aria-hidden />
                    ) : (
                      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                    )}
                    {typedCategoryCheck.name ?? "Not a real eBay category ID — the upload will fail"}
                  </p>
                )}
              </div>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-3 size-5 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  type="text"
                  placeholder="Search category by name…"
                  aria-label="Search eBay categories"
                  value={catQuery}
                  onChange={(e) => setCatQuery(e.target.value)}
                  className="pl-10"
                />
                {catResults.length > 0 && (
                  <div className="absolute inset-x-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface text-sm shadow-lg">
                    {catResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          onChange({ categoryId: c.id });
                          setCatQuery("");
                          setCatResults([]);
                        }}
                        className="block w-full border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted"
                      >
                        <span className="font-medium text-foreground">{c.name}</span>{" "}
                        <span className="text-muted-foreground tabular-nums">({c.id})</span>
                        <span className="block text-xs text-muted-foreground">{c.path}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={searchCategory} disabled={searchingCategory}>
                <Sparkles className={cn("size-4", searchingCategory && "animate-pulse")} aria-hidden />
                {searchingCategory ? "Finding category…" : "Auto-find category"}
              </Button>
              {suggestion && !item.categoryId && (
                <Button variant="ghost" size="sm" onClick={() => onChange({ categoryId: suggestion.categoryId })}>
                  Use suggested: {suggestion.categoryName} ({suggestion.categoryId})
                </Button>
              )}
            </div>
            {categorySearchError && <p className="mt-2 text-xs font-medium text-danger">{categorySearchError}</p>}
            {categorySearchResult && (
              <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-2.5 text-xs text-green-900">
                <p>
                  Applied: <strong>{categorySearchResult.categoryName}</strong> ({categorySearchResult.categoryId})
                  {categorySearchResult.fromExistingRule ? " — from a saved rule" : " — saved as a rule for next time"}
                </p>
                {categorySearchResult.sourceUrl && (
                  <a
                    href={categorySearchResult.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 font-medium text-primary hover:underline"
                  >
                    Verify source
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
              </div>
            )}

            {item.categoryId && (
              <div className="mt-4 border-t border-border pt-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  Typed a category ID in by hand? Save it as a rule so matching titles get it automatically:
                </p>
                <div className="flex flex-col gap-2 sm:flex-row lg:flex-col 2xl:flex-row">
                  <Input
                    size="sm"
                    type="text"
                    placeholder="Keyword (e.g. hair dye)"
                    aria-label="Rule keyword"
                    value={ruleKeyword}
                    onChange={(e) => setRuleKeyword(e.target.value)}
                  />
                  <Input
                    size="sm"
                    type="text"
                    placeholder="Category name (optional)"
                    aria-label="Rule category name"
                    value={ruleName}
                    onChange={(e) => setRuleName(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    disabled={!ruleKeyword.trim()}
                    onClick={() => {
                      onSaveRule(ruleKeyword.trim(), item.categoryId as string, ruleName.trim() || ruleKeyword.trim());
                      setRuleKeyword("");
                      setRuleName("");
                    }}
                    className="shrink-0"
                  >
                    Remember
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border p-3 sm:p-4">
            <p className="mb-3 text-sm font-medium text-foreground">
              Item specifics
              {item.itemSpecifics && (
                <span className="ml-1 font-normal text-muted-foreground">(AI-suggested, edit as needed)</span>
              )}
            </p>
            {Object.keys(item.itemSpecifics ?? {}).length > 0 && (
              <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                {Object.entries(item.itemSpecifics ?? {}).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 truncate text-xs font-medium capitalize text-muted-foreground" title={key}>
                      {key}
                    </span>
                    <Input
                      key={`${key}-${value}`}
                      size="sm"
                      type="text"
                      defaultValue={value}
                      onBlur={(e) => {
                        if (e.target.value !== value) updateSpecific(key, e.target.value);
                      }}
                      aria-label={key}
                      className="min-w-0"
                    />
                    <button
                      type="button"
                      onClick={() => removeSpecific(key)}
                      aria-label={`Remove ${key}`}
                      className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-danger"
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                size="sm"
                type="text"
                placeholder="Field (e.g. Style)"
                aria-label="New specific name"
                value={newSpecKey}
                onChange={(e) => setNewSpecKey(e.target.value)}
              />
              <Input
                size="sm"
                type="text"
                placeholder="Value"
                aria-label="New specific value"
                value={newSpecValue}
                onChange={(e) => setNewSpecValue(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={!newSpecKey.trim() || !newSpecValue.trim()}
                onClick={() => {
                  updateSpecific(newSpecKey.trim().toLowerCase(), newSpecValue.trim());
                  setNewSpecKey("");
                  setNewSpecValue("");
                }}
                className="shrink-0"
              >
                <Plus className="size-4" aria-hidden />
                Add
              </Button>
            </div>
          </div>
          <Field label="Sold comps notes" hint="Paste from Terapeak — for your reference only.">
            <Input
              key={`comps-${item.id}-${item.compNotes ?? ""}`}
              type="text"
              placeholder="e.g. 12 sold, $14–$19"
              defaultValue={item.compNotes ?? ""}
              onBlur={(e) => {
                if (e.target.value !== (item.compNotes ?? "")) onChange({ compNotes: e.target.value });
              }}
            />
          </Field>
      </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-background px-4 py-3 sm:px-5 lg:sticky lg:bottom-0 lg:z-10">
        <Button variant="danger-ghost" onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden />
          Delete
        </Button>
        <Button onClick={onMarkReady} disabled={binHold(item) != null} title={binHold(item) ?? undefined}>
          <Check className="size-4" aria-hidden />
          {binHold(item) ? "Waiting for a bin" : "Mark ready"}
        </Button>
      </div>
    </Card>
  );
}

// Number input with a unit suffix (lb / oz) — uncontrolled, like the rest of
// ItemCard's fields, saving on blur.
function SuffixNumber({ suffix, ...props }: Omit<ComponentProps<typeof Input>, "type"> & { suffix: string }) {
  return (
    <div className="relative">
      <Input type="number" placeholder="0" onWheel={(e) => e.currentTarget.blur()} {...props} className="pr-10" />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
        {suffix}
      </span>
    </div>
  );
}

// Live listings whose manifest retail looks wrong (see src/lib/retailCheck.ts):
// type the real retail for one unit, or say it's right. Owner only: the API
// refuses anyone else, and this then shows nothing.
function RetailCheckSection() {
  const [rows, setRows] = useState<RetailCheckRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    fetch("/api/retail-check")
      .then(async (r) => setRows(r.ok ? ((await r.json()).rows as RetailCheckRow[]) : null))
      .catch(() => setRows(null));
  }

  useEffect(load, []);

  async function save(line: RetailCheckLine, unitRetail: number | null) {
    const key = `${line.manifestId}:${line.upc}`;
    setSavingKey(key);
    setMessage(null);
    try {
      const res = await fetch("/api/retail-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestId: line.manifestId, upc: line.upc, unitRetail }),
      });
      if (!res.ok) {
        setMessage((await res.json().catch(() => ({}))).error ?? "Couldn't save.");
        return;
      }
      setDrafts((d) => ({ ...d, [key]: "" }));
      load();
    } finally {
      setSavingKey(null);
    }
  }

  if (!rows || rows.length === 0) return null;
  return (
    <section>
      <SectionHeader
        title="Retail to check"
        description="Live listings where the manifest retail looks off. The store prices off retail and shows it crossed out, so fix it or say it's right."
        action={<Badge tone="warning">{rows.length}</Badge>}
      />
      {message && <Alert tone="danger">{message}</Alert>}
      <Card padded={false} className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.itemId} className="flex flex-col gap-3 p-4">
            <div className="flex items-start gap-3">
              {row.photoUrl && <Thumb src={row.photoUrl} size="sm" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{row.title}</p>
                <p className="text-xs text-muted-foreground">
                  eBay ${row.ebayPrice.toFixed(2)} · retail ${row.retail.toFixed(2)} · store ${row.storePrice.toFixed(2)}
                </p>
                <p className="text-xs text-warning">
                  {row.reason === "too_high"
                    ? "Retail is over 4x the eBay price, so the store hides it and prices this as no-retail."
                    : "Retail is under half the eBay price, so 50% off it makes the store price very low."}
                </p>
              </div>
            </div>
            {row.lines.map((line) => {
              const key = `${line.manifestId}:${line.upc}`;
              const draft = drafts[key] ?? "";
              const saving = savingKey === key;
              return (
                <div key={key} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {line.description}: ${line.unitRetail.toFixed(2)} each{line.units > 1 ? `, ${line.units} in this listing` : ""}
                  </span>
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    placeholder="Real retail"
                    className="w-28"
                    value={draft}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  />
                  <Button size="sm" onClick={() => save(line, Number(draft))} disabled={saving || !(Number(draft) > 0)}>
                    Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => save(line, null)} disabled={saving}>
                    Looks right
                  </Button>
                </div>
              );
            })}
          </div>
        ))}
      </Card>
    </section>
  );
}
