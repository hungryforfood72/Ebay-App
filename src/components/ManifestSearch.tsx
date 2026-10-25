"use client";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Find a product on the load by name or Item # (GET /api/sort/search), for
// products with no UPC to scan (Cristian, 2026-10-25: the medical load's
// Bard leg bags, on the List page). The sort page has its own copy of this.

export type ManifestSearchResult = { key: string; lineId: string; description: string; label: string };

export function ManifestSearch({
  manifestId,
  onPick,
  onCancel,
}: {
  manifestId: string;
  onPick: (result: ManifestSearchResult) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ManifestSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Opens under the scan field, below the fold on the handheld.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    boxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults(null);
      return;
    }
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/sort/search?manifestId=${encodeURIComponent(manifestId)}&q=${encodeURIComponent(text)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Couldn't search.");
        if (!cancelled) {
          setResults(data.results ?? []);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't search.");
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [q, manifestId]);

  return (
    <div ref={boxRef} className="scroll-mt-20">
    <Card padded={false} className="p-3">
      <div className="flex gap-2">
        <Input
          autoFocus
          type="search"
          enterKeyHint="search"
          placeholder="Name or Item #"
          aria-label="Search this load by name or Item #"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-danger">{error}</p>
      ) : q.trim().length < 2 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Type part of the name, like &quot;leg bag&quot;, or the Item # (REF number), like 150832.
        </p>
      ) : results === null ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Searching…
        </p>
      ) : results.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Nothing on this load matches.</p>
      ) : (
        <ul className="mt-2 flex max-h-80 flex-col gap-1.5 overflow-y-auto">
          {results.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => onPick(r)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-left active:bg-muted"
              >
                <span className="line-clamp-2 block text-sm font-medium text-foreground">{r.description}</span>
                <span className="block text-xs text-muted-foreground">{r.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
    </div>
  );
}
