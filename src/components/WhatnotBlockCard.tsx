"use client";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { SetAsideWhy } from "@/components/PackSuggestionCard";
import { HeartHandshake } from "lucide-react";
import { useState } from "react";

// A Whatnot listing the List page can't make (Cristian, 2026-11-06):
// Whatnot doesn't allow the product, or its date is too close for a show
// (src/lib/whatnotPolicy.ts). The lister sets it aside for donation; on a
// load it's recorded as donated (a dud entry, decision "donate"). The owner
// can overrule a product block ("Whatnot allows it"), never a date.
export function WhatnotBlockCard({
  code,
  manifestId,
  reason,
  units,
  why,
  canAllow,
  onDone,
  onAllowed,
}: {
  code: string;
  manifestId: string | null;
  reason: string;
  units: number;
  // The pack card's why, when it came from "List it for Whatnot".
  why: SetAsideWhy | null;
  // Owner, and a product block (not a date).
  canAllow: boolean;
  onDone: (message: string) => void;
  onAllowed: () => void;
}) {
  const [count, setCount] = useState(String(units > 0 ? units : 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/whatnot-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, manifestId, ...body }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error ?? "Couldn't save that.");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function donate() {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) return setError("Enter how many, at least 1.");
    if (!manifestId) return onDone(`Set ${n === 1 ? "it" : `all ${n}`} aside for donation. Ready for the next item.`);
    if (await post({ action: "donate", quantity: n, reason, why })) {
      onDone(`Set ${n === 1 ? "it" : `all ${n}`} aside for donation (marked donated). Ready for the next item.`);
    }
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-950">
      <div className="flex gap-2">
        <HeartHandshake className="mt-0.5 size-5 shrink-0 text-red-700" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Can&apos;t go on Whatnot. Set it aside for donation.</p>
          <p className="mt-0.5 text-red-900/80">{reason}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span>Donate</span>
            <Input
              className="w-20"
              type="number"
              min={1}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              onWheel={(e) => e.currentTarget.blur()}
              aria-label="How many to set aside for donation"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={donate} disabled={busy}>
              Set aside for donation, scan the next item
            </Button>
            {canAllow && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  if (await post({ action: "allow" })) onAllowed();
                }}
              >
                Whatnot allows it
              </Button>
            )}
          </div>
          {error && (
            <>
              <p className="mt-2 text-red-700">{error}</p>
              <button
                type="button"
                className="mt-1 text-xs font-medium underline"
                onClick={() => onDone("Set it aside for donation (not recorded). Ready for the next item.")}
                disabled={busy}
              >
                Skip recording it
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
