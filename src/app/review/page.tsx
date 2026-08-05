"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type CategoryRule = {
  id: string;
  keyword: string;
  categoryId: string;
  categoryName: string;
};

type BundleComponent = {
  upc: string;
  quantity: number;
  photoUrl?: string | null;
  name?: string | null;
};

type Item = {
  id: string;
  sku: string;
  status: "pending_review" | "ready" | "exported";
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
};

type BoxSize = { id: string; label: string };

export default function ReviewPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [rules, setRules] = useState<CategoryRule[]>([]);
  const [boxSizes, setBoxSizes] = useState<BoxSize[]>([]);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftingId, setDraftingId] = useState<string | null>(null);

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
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ebay-export.csv";
      a.click();
      URL.revokeObjectURL(url);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setExporting(false);
    }
  }

  if (!items) return <main className="p-6">Loading…</main>;

  const pending = items.filter((i) => i.status === "pending_review");
  const ready = items.filter((i) => i.status === "ready");
  const exported = items.filter((i) => i.status === "exported");

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Review Queue</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">
            {ready.length} ready to export
          </span>
          <button
            type="button"
            onClick={exportReady}
            disabled={exporting || ready.length === 0}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {exporting ? "Exporting…" : "Download CSV for eBay"}
          </button>
          <Link href="/scan" className="text-sm underline">
            Scan
          </Link>
          <Link href="/settings" className="text-sm underline">
            Settings
          </Link>
        </div>
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <h2 className="mb-2 text-sm font-medium text-gray-500">
        Pending review ({pending.length})
      </h2>
      <div className="mb-8 flex flex-col gap-3">
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
          <p className="text-sm text-gray-400">Nothing waiting on review.</p>
        )}
      </div>

      <h2 className="mb-2 text-sm font-medium text-gray-500">
        Ready to list ({ready.length})
      </h2>
      <div className="mb-8 flex flex-col gap-2">
        {ready.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-3 rounded border p-3 text-sm"
          >
            {item.photoUrls[0] && (
              <img
                src={item.photoUrls[0]}
                alt=""
                className="h-10 w-10 rounded object-cover"
              />
            )}
            <span className="flex-1">{item.finalTitle}</span>
            <span className="text-gray-500">${item.price}</span>
          </div>
        ))}
      </div>

      {exported.length > 0 && (
        <>
          <h2 className="mb-2 text-sm font-medium text-gray-500">
            Exported ({exported.length})
          </h2>
          <div className="flex flex-col gap-2">
            {exported.map((item) => (
              <div key={item.id} className="text-sm text-gray-400">
                {item.finalTitle} — SKU {item.sku}
              </div>
            ))}
          </div>
        </>
      )}
    </main>
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
    <div className="flex flex-col gap-3 rounded border p-4 md:flex-row">
      <div className="flex gap-2 md:w-40 md:flex-col">
        {item.photoUrls.map((url) => (
          <img
            key={url}
            src={url}
            alt=""
            className="h-20 w-20 rounded object-cover"
          />
        ))}
      </div>

      <div className="flex-1">
        <div className="mb-2 flex flex-wrap gap-3 text-xs text-gray-500">
          {item.isBundle ? (
            <span>Bundle · {item.bundleComponents?.length ?? 0} different items</span>
          ) : (
            <span>UPC {item.upc}</span>
          )}
          <span>{item.isBundle ? "Bundles available" : "Qty"} {item.quantity}</span>
          {item.isMultipack && <span>Pack of {item.packSize}</span>}
          <span>Shelf {item.shelfLocation}</span>
          {item.expirationDate && (
            <span>
              Exp {new Date(item.expirationDate).toLocaleDateString()}
            </span>
          )}
        </div>

        {item.isBundle && item.bundleComponents && item.bundleComponents.length > 0 && (
          <div className="mb-2 rounded border bg-gray-50 p-2">
            <p className="mb-1 text-xs font-medium text-gray-500">Bundle contents</p>
            <ul className="flex flex-col gap-1">
              {item.bundleComponents.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-xs text-gray-600">
                  {c.photoUrl && (
                    <img src={c.photoUrl} alt="" className="h-6 w-6 rounded object-cover" />
                  )}
                  <span>
                    {c.quantity}x {c.name ?? `UPC ${c.upc}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onGenerateDraft}
            disabled={drafting}
            className="rounded border px-3 py-1 text-xs disabled:opacity-40"
          >
            {drafting ? "Drafting…" : item.aiTitle ? "Regenerate AI draft" : "Generate AI draft"}
          </button>
          {drafting && (
            <span className="text-xs text-gray-500">
              Looking up the UPC and asking Claude for a title/description…
            </span>
          )}
          {!drafting && !item.aiTitle && (
            <span className="text-xs text-gray-400">
              Drafts and categories now start automatically when an item is scanned —
              give it a minute, or click to generate now.
            </span>
          )}
        </div>

        <input
          key={`title-${item.id}-${item.aiTitle ?? ""}`}
          type="text"
          placeholder="Title"
          defaultValue={item.finalTitle ?? ""}
          maxLength={80}
          onChange={(e) => setTitleLength(e.target.value.length)}
          onBlur={(e) => onChange({ finalTitle: e.target.value })}
          className="w-full rounded border px-3 py-2 text-sm"
        />
        <p className={`mb-2 text-right text-xs ${titleLength >= 80 ? "text-red-600" : "text-gray-400"}`}>
          {titleLength}/80
        </p>
        <textarea
          key={`desc-${item.id}-${item.aiDescription ?? ""}`}
          placeholder="Description"
          defaultValue={item.finalDescription ?? ""}
          onBlur={(e) => onChange({ finalDescription: e.target.value })}
          rows={2}
          className="mb-2 w-full rounded border px-3 py-2 text-sm"
        />

        <div className="flex flex-wrap gap-2">
          <input
            type="number"
            step="0.01"
            placeholder="Price"
            defaultValue={item.price ?? ""}
            onBlur={(e) => onChange({ price: e.target.value })}
            onWheel={(e) => e.currentTarget.blur()}
            className="w-24 rounded border px-3 py-2 text-sm"
          />
          <div className="flex flex-col gap-1">
            <input
              key={`cat-${item.id}-${item.categoryId ?? ""}`}
              type="text"
              placeholder="Category ID"
              title="eBay category ID"
              defaultValue={item.categoryId ?? ""}
              onBlur={(e) => onChange({ categoryId: e.target.value })}
              className="w-32 rounded border px-3 py-2 text-sm"
            />
            <div className="relative">
              <input
                type="text"
                placeholder="Search category by name…"
                value={catQuery}
                onChange={(e) => setCatQuery(e.target.value)}
                className="w-56 rounded border px-2 py-1 text-xs"
              />
              {catResults.length > 0 && (
                <div className="absolute z-10 mt-1 max-h-56 w-80 overflow-y-auto rounded border bg-white text-xs shadow-lg">
                  {catResults.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        onChange({ categoryId: c.id });
                        setCatQuery("");
                        setCatResults([]);
                      }}
                      className="block w-full border-b px-2 py-1 text-left last:border-b-0 hover:bg-gray-100"
                    >
                      <span className="font-medium">{c.name}</span> ({c.id})
                      <br />
                      <span className="text-gray-400">{c.path}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {suggestion && !item.categoryId && (
              <button
                type="button"
                onClick={() => onChange({ categoryId: suggestion.categoryId })}
                className="text-left text-xs text-blue-600 underline"
              >
                Suggested: {suggestion.categoryName} ({suggestion.categoryId})
              </button>
            )}
            <button
              type="button"
              onClick={searchCategory}
              disabled={searchingCategory}
              title="Searches eBay's real category tree and has Claude pick the best match — usually a few seconds"
              className="text-left text-xs text-gray-500 underline disabled:opacity-40"
            >
              {searchingCategory ? "Finding category…" : "Auto-find category (AI)"}
            </button>
            {categorySearchError && (
              <span className="text-xs text-red-600">{categorySearchError}</span>
            )}
            {categorySearchResult && (
              <div className="rounded border border-green-200 bg-green-50 p-2 text-xs">
                <p>
                  Applied: {categorySearchResult.categoryName} ({categorySearchResult.categoryId})
                  {categorySearchResult.fromExistingRule
                    ? " — from a saved rule"
                    : " — saved as a rule for next time"}
                </p>
                {categorySearchResult.sourceUrl && (
                  <a
                    href={categorySearchResult.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 underline"
                  >
                    verify source
                  </a>
                )}
              </div>
            )}
          </div>
          <select
            defaultValue={item.condition ?? ""}
            onChange={(e) => onChange({ condition: e.target.value || null })}
            className="rounded border px-3 py-2 text-sm"
          >
            <option value="">Condition…</option>
            <option value="new">New</option>
            <option value="new_other">New (other)</option>
            <option value="used">Used</option>
            <option value="for_parts">For parts</option>
          </select>
          <input
            type="text"
            placeholder="Sold comps (paste from Terapeak)"
            defaultValue={item.compNotes ?? ""}
            onBlur={(e) => onChange({ compNotes: e.target.value })}
            className="min-w-48 flex-1 rounded border px-3 py-2 text-sm"
          />
        </div>

        <div className="mt-2 rounded border p-2">
          <p className="mb-1 text-xs font-medium text-gray-500">
            Shipping — free, USPS Ground Advantage
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={item.boxSize ?? ""}
              onChange={(e) => onChange({ boxSize: e.target.value || null })}
              className="rounded border px-2 py-1 text-xs"
            >
              <option value="">Box size…</option>
              {boxSizes.map((b) => (
                <option key={b.id} value={b.label}>
                  {b.label}
                </option>
              ))}
            </select>
            {boxSizes.length === 0 && (
              <Link href="/settings" className="text-xs text-blue-600 underline">
                Add box sizes in Settings
              </Link>
            )}
            <input
              type="number"
              min={0}
              placeholder="lb"
              defaultValue={item.weightLbs ?? ""}
              onBlur={(e) =>
                onChange({ weightLbs: e.target.value ? Number(e.target.value) : null })
              }
              onWheel={(e) => e.currentTarget.blur()}
              className="w-16 rounded border px-2 py-1 text-xs"
            />
            <span className="text-xs text-gray-400">lb</span>
            <input
              type="number"
              min={0}
              max={15}
              placeholder="oz"
              defaultValue={item.weightOz ?? ""}
              onBlur={(e) =>
                onChange({ weightOz: e.target.value ? Number(e.target.value) : null })
              }
              onWheel={(e) => e.currentTarget.blur()}
              className="w-16 rounded border px-2 py-1 text-xs"
            />
            <span className="text-xs text-gray-400">oz</span>
            <span className="text-xs text-gray-400">
              Weight/box matter either way — accurate numbers keep eBay&apos;s calculated cost
              (or your absorbed cost on free shipping) from defaulting high.
            </span>
          </div>
        </div>

        <div className="mt-2 rounded border p-2">
          <p className="mb-1 text-xs font-medium text-gray-500">
            Item specifics {item.itemSpecifics ? "(AI-suggested, edit as needed)" : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(item.itemSpecifics ?? {}).map(([key, value]) => (
              <div key={key} className="flex items-center gap-1">
                <span className="text-xs capitalize text-gray-500">{key}:</span>
                <input
                  type="text"
                  defaultValue={value}
                  onBlur={(e) => updateSpecific(key, e.target.value)}
                  className="w-28 rounded border px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={() => removeSpecific(key)}
                  className="text-xs text-gray-400"
                >
                  ×
                </button>
              </div>
            ))}
            <input
              type="text"
              placeholder="Field (e.g. Style)"
              value={newSpecKey}
              onChange={(e) => setNewSpecKey(e.target.value)}
              className="w-28 rounded border px-2 py-1 text-xs"
            />
            <input
              type="text"
              placeholder="Value"
              value={newSpecValue}
              onChange={(e) => setNewSpecValue(e.target.value)}
              className="w-28 rounded border px-2 py-1 text-xs"
            />
            <button
              type="button"
              disabled={!newSpecKey.trim() || !newSpecValue.trim()}
              onClick={() => {
                updateSpecific(newSpecKey.trim().toLowerCase(), newSpecValue.trim());
                setNewSpecKey("");
                setNewSpecValue("");
              }}
              className="rounded border px-2 py-1 text-xs disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>

        {item.categoryId && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-400">
              Typed a category ID in by hand? Save it as a rule too:
            </span>
            <input
              type="text"
              placeholder="Keyword to remember this category by (e.g. hair dye)"
              value={ruleKeyword}
              onChange={(e) => setRuleKeyword(e.target.value)}
              className="w-56 rounded border px-2 py-1 text-xs"
            />
            <input
              type="text"
              placeholder="Category name (optional)"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              className="w-40 rounded border px-2 py-1 text-xs"
            />
            <button
              type="button"
              disabled={!ruleKeyword.trim()}
              onClick={() => {
                onSaveRule(
                  ruleKeyword.trim(),
                  item.categoryId as string,
                  ruleName.trim() || ruleKeyword.trim()
                );
                setRuleKeyword("");
                setRuleName("");
              }}
              className="rounded border px-2 py-1 text-xs disabled:opacity-40"
            >
              Remember this category
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-2 md:flex-col md:justify-start">
        <button
          type="button"
          onClick={onMarkReady}
          className="h-fit rounded bg-black px-4 py-2 text-sm text-white"
        >
          Mark ready
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="h-fit rounded border border-red-300 px-4 py-2 text-sm text-red-600"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
