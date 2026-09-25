"use client";

import { Alert } from "@/components/ui/Alert";
import { AppShell } from "@/components/ui/AppShell";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, SectionHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import {
  Check,
  Download,
  ExternalLink,
  Package,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
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
  status: "pending_review" | "ready" | "exported" | "listed";
  upc: string | null;
  quantity: number;
  isMultipack: boolean;
  packSize: number | null;
  expirationDate: string | null;
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
  const [draftingId, setDraftingId] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [bulkPublishing, setBulkPublishing] = useState(false);

  async function load() {
    const [itemsRes, rulesRes, boxSizesRes] = await Promise.all([
      fetch("/api/items"),
      fetch("/api/category-rules"),
      fetch("/api/box-sizes"),
    ]);
    setItems(await itemsRes.json());
    setRules(await rulesRes.json());
    setBoxSizes(await boxSizesRes.json());
  }

  useEffect(() => {
    // Initial data load on mount, not a reaction to state we own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    setItems(
      (prev) =>
        prev?.map((i) => (i.id === id ? { ...i, ...data } : i)) ?? prev
    );
    await fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
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

  async function markReady(item: Item) {
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
    if (!item.weightLbs && !item.weightOz) {
      setError(`"${label}" needs a package weight before it can go ready.`);
      return;
    }
    setError(null);
    await updateItem(item.id, { status: "ready" });
  }

  // Distinct from "Mark ready" — this is the actual, not-cleanly-undoable
  // publish to eBay via the real Inventory API. Errors (a bad category ID,
  // a missing business policy, etc.) come back from eBay's own validation
  // and are shown inline on the item rather than swallowed. Returns whether
  // it succeeded, so publishAllToEbay can tally results across a batch.
  async function publishToEbay(item: Item): Promise<boolean> {
    setPublishingId(item.id);
    setError(null);
    try {
      const res = await fetch(`/api/items/${item.id}/publish-to-ebay`, { method: "POST" });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error ?? "Publish failed.");
      }
      setItems((prev) => prev?.map((i) => (i.id === item.id ? result : i)) ?? prev);
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
        `Publish all ${ready.length} ready item(s) to eBay now? This creates real, live listings and isn't easily undone.`
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
                      <p className="text-sm font-semibold tabular-nums text-foreground">${item.price}</p>
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
                  {item.ebayPublishError && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
                      eBay rejected this: {item.ebayPublishError}
                    </p>
                  )}
                </div>
              ))}
            </Card>
          )}
        </section>

        {listed.length > 0 && (
          <section>
            <SectionHeader title="Listed on eBay" action={<Badge tone="success">{listed.length}</Badge>} />
            <Card padded={false} className="divide-y divide-border">
              {listed.map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate text-foreground">{item.finalTitle}</span>
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
    count: number;
    median: number | null;
    low: number | null;
    high: number | null;
    retailPrice: number | null;
  } | null>(null);
  const [priceResearchError, setPriceResearchError] = useState<string | null>(null);
  const priceResearchedFor = useRef<string | null>(null);

  // Active-listing comps only — there's no API path to real sold-price data
  // (eBay's Marketplace Insights API is closed to new applicants), so this
  // is framed as "based on active competition," never auto-fills the price
  // field, purely advisory. Comps are totalPrice (item + real fixed
  // shipping cost), not just the item's own price, so a free-shipping
  // listing and a cheaper-item-plus-shipping listing compare fairly.
  async function researchPrice() {
    setPriceResearching(true);
    setPriceResearchError(null);
    setPriceResearchResult(null);
    try {
      const res = await fetch(`/api/items/${item.id}/price-research`);
      const result = await res.json();
      if (!res.ok) {
        // Manifest retail price doesn't depend on the eBay call succeeding
        // — still show it even if the comp search itself failed.
        if (result.retailPrice != null) {
          setPriceResearchResult({ count: 0, median: null, low: null, high: null, retailPrice: result.retailPrice });
        }
        throw new Error(result.error ?? "Price research failed.");
      }
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
    <Card padded={false} className="overflow-hidden">
      <div className="p-4 sm:p-5">
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
          <Badge>Shelf {item.shelfLocation}</Badge>
          {item.expirationDate && (
            <Badge tone="warning">Exp {new Date(item.expirationDate).toLocaleDateString()}</Badge>
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
                        · exp {new Date(c.expirationDate).toLocaleDateString()}
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
            <Input
              id={`title-${item.id}`}
              key={`title-${item.id}-${item.aiTitle ?? ""}`}
              type="text"
              placeholder="Title"
              defaultValue={item.finalTitle ?? ""}
              maxLength={80}
              onChange={(e) => setTitleLength(e.target.value.length)}
              onBlur={(e) => onChange({ finalTitle: e.target.value })}
            />
          </div>

          <Field label="Description">
            <Textarea
              key={`desc-${item.id}-${item.aiDescription ?? ""}`}
              placeholder="Description"
              defaultValue={item.finalDescription ?? ""}
              onBlur={(e) => onChange({ finalDescription: e.target.value })}
              rows={4}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Field label="Price">
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">
                    $
                  </span>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    defaultValue={item.price ?? ""}
                    onBlur={(e) => onChange({ price: e.target.value })}
                    onWheel={(e) => e.currentTarget.blur()}
                    className="pl-7"
                  />
                </div>
              </Field>
              <div className="mt-2 flex flex-col gap-1 rounded-lg bg-background p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-muted-foreground">Active comps (shipped)</span>
                  <button
                    type="button"
                    onClick={researchPrice}
                    disabled={priceResearching}
                    title="Searches active (not sold) listings for this UPC, total price includes the seller's shipping charge when it's a fixed cost — advisory only, doesn't change the price"
                    className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    <RefreshCw className={cn("size-3.5", priceResearching && "animate-spin")} aria-hidden />
                    {priceResearching ? "Checking…" : "Refresh"}
                  </button>
                </div>
                {priceResearchError && <span className="text-danger">{priceResearchError}</span>}
                {!priceResearchError && priceResearchResult && priceResearchResult.count === 0 && (
                  <span className="text-muted-foreground">No active comps found.</span>
                )}
                {priceResearchResult && priceResearchResult.count > 0 && (
                  <span className="text-foreground">
                    ${priceResearchResult.low?.toFixed(2)}–${priceResearchResult.high?.toFixed(2)} · median{" "}
                    <strong>${priceResearchResult.median?.toFixed(2)}</strong> · {priceResearchResult.count} comp
                    {priceResearchResult.count === 1 ? "" : "s"}
                  </span>
                )}
                {priceResearchResult?.retailPrice != null && (
                  <span className="text-foreground">
                    Manifest retail ${priceResearchResult.retailPrice.toFixed(2)}
                    {priceResearchResult.median != null && (
                      <span className="text-muted-foreground">
                        {` (comps ${priceResearchResult.median >= priceResearchResult.retailPrice ? "above" : "below"} retail)`}
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>

            <Field label="Condition">
              <Select
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
          </div>

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
                <div className="flex flex-col gap-2 sm:flex-row">
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

          <Field label="Sold comps notes" hint="Paste from Terapeak — for your reference only.">
            <Input
              type="text"
              placeholder="e.g. 12 sold, $14–$19"
              defaultValue={item.compNotes ?? ""}
              onBlur={(e) => onChange({ compNotes: e.target.value })}
            />
          </Field>

          <div className="rounded-lg border border-border p-3 sm:p-4">
            <p className="text-sm font-medium text-foreground">Shipping</p>
            <p className="mb-3 text-xs text-muted-foreground">
              Free, USPS Ground Advantage. Weight/box matter either way — accurate numbers keep eBay&apos;s calculated
              cost (or your absorbed cost on free shipping) from defaulting high.
            </p>
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
                suffix="lb"
                min={0}
                defaultValue={item.weightLbs ?? ""}
                onBlur={(e) => onChange({ weightLbs: e.target.value ? Number(e.target.value) : null })}
              />
              <SuffixNumber
                suffix="oz"
                min={0}
                max={15}
                defaultValue={item.weightOz ?? ""}
                onBlur={(e) => onChange({ weightOz: e.target.value ? Number(e.target.value) : null })}
              />
            </div>
          </div>

          <div className="rounded-lg border border-border p-3 sm:p-4">
            <p className="mb-3 text-sm font-medium text-foreground">
              Item specifics
              {item.itemSpecifics && (
                <span className="ml-1 font-normal text-muted-foreground">(AI-suggested, edit as needed)</span>
              )}
            </p>
            {Object.keys(item.itemSpecifics ?? {}).length > 0 && (
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                {Object.entries(item.itemSpecifics ?? {}).map(([key, value]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 truncate text-xs font-medium capitalize text-muted-foreground" title={key}>
                      {key}
                    </span>
                    <Input
                      size="sm"
                      type="text"
                      defaultValue={value}
                      onBlur={(e) => updateSpecific(key, e.target.value)}
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
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-background px-4 py-3 sm:px-5">
        <Button variant="danger-ghost" onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden />
          Delete
        </Button>
        <Button onClick={onMarkReady}>
          <Check className="size-4" aria-hidden />
          Mark ready
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
