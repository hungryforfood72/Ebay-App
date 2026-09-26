"use client";

import { Button } from "@/components/ui/Button";
import { Boxes, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

type PackPlanGroup = { packSize: number; listings: number };

type PackSuggestion = {
  alreadyMultipack: boolean;
  available: number | null;
  plan: PackPlanGroup[] | null;
  recommendation: {
    packSize: number;
    basis: "listings" | "estimate";
    compCount: number;
    // Owner only — absent for an employee.
    perPackPrice?: number;
    netPerUnit?: number;
    singleNetPerUnit?: number | null;
  } | null;
};

const packLabel = (size: number) => (size > 1 ? `${size}-pack` : "single");
const listingsOf = (g: PackPlanGroup) =>
  g.listings === 1
    ? g.packSize > 1
      ? `1 listing of a ${g.packSize}-pack`
      : "1 single"
    : `${g.listings} listings of ${g.packSize > 1 ? `${g.packSize}-packs` : "singles"}`;
const money = (n: number) => `$${n.toFixed(2)}`;

// On the scan page's quantity step: what pack size this UPC sells best in
// (from live eBay listings, see /api/pack-suggestion) and, on a manifest,
// how to split what's left of it. "Fill in" sets the pack size and quantity
// for the first group; after saving, scanning the same UPC again shows the
// plan for whatever's still left.
export function PackSuggestionCard({
  upc,
  manifestId,
  onApply,
}: {
  upc: string;
  manifestId: string | null;
  onApply: (packSize: number, listings: number | null) => void;
}) {
  const key = `${upc}|${manifestId ?? ""}`;
  const [result, setResult] = useState<{ key: string; data: PackSuggestion | null } | null>(null);
  const loading = result?.key !== key;

  useEffect(() => {
    const params = new URLSearchParams({ upc });
    if (manifestId) params.set("manifestId", manifestId);
    let cancelled = false;
    fetch(`/api/pack-suggestion?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data: PackSuggestion | null) => !cancelled && setResult({ key, data }));
    return () => {
      cancelled = true;
    };
  }, [upc, manifestId, key]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Checking eBay for the best pack size…
      </div>
    );
  }

  const data = result?.data;
  const rec = data?.recommendation;
  if (!data || data.alreadyMultipack || !rec) return null;

  const first = data.plan?.[0] ?? null;
  const rest = data.plan?.slice(1) ?? [];

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
      <div className="flex gap-2">
        <Boxes className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold">
            Suggested: sell as {rec.packSize > 1 ? `${rec.packSize}-packs` : "singles"}
          </p>
          <p className="mt-0.5 text-blue-900/80">
            {rec.basis === "estimate"
              ? `Only singles are listed on eBay, and shipping eats most of a single's price, so a ${packLabel(rec.packSize)} should earn more per item.`
              : `Based on ${rec.compCount} eBay listing${rec.compCount === 1 ? "" : "s"} of ${rec.packSize > 1 ? `${rec.packSize}-packs` : "singles"}.`}
            {rec.perPackPrice != null && rec.netPerUnit != null && (
              <>
                {" "}
                About {money(rec.perPackPrice)} per {packLabel(rec.packSize)}, {money(rec.netPerUnit)} per item after
                fees and shipping
                {rec.packSize > 1 && rec.singleNetPerUnit != null && <> vs {money(rec.singleNetPerUnit)} as singles</>}.
              </>
            )}
          </p>

          {data.plan && data.available != null && (
            <p className="mt-2">
              <span className="font-medium">{data.available} left on this manifest:</span>{" "}
              {data.plan.map(listingsOf).join(" + ")}.
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {first ? (
              <Button size="sm" onClick={() => onApply(first.packSize, first.listings)}>
                Fill in {listingsOf(first)}
              </Button>
            ) : (
              <Button size="sm" onClick={() => onApply(rec.packSize, null)}>
                Fill in {packLabel(rec.packSize)}
              </Button>
            )}
            {rest.length > 0 && (
              <span className="text-xs text-blue-900/80">
                Then save and scan it again for the {rest.map(listingsOf).join(" + ")}.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
