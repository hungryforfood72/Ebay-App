"use client";

import { ChevronRight, PackageX } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// "Pull these from the bins" on the List page (Cristian, 2026-10-25), so the
// people at the scanners see it without going to the Dashboard: listings
// that came off eBay for their date, or because the package says Rx Only
// (those go back to the supplier). Opens the Pull page (/pulls), where each
// unit is scanned as it comes off the shelf (2026-10-26; no more "Pulled
// them all" on trust). Listings that need a relist split stay on the
// Dashboard.

const REFRESH_MS = 60_000;

export function PullBanner() {
  const [count, setCount] = useState(0);

  const load = useCallback(() => {
    fetch("/api/pulls", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setCount((d.items ?? []).length))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  if (count === 0) return null;
  return (
    <Link href="/pulls" className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-red-950">
      <PackageX className="size-5 shrink-0 text-danger" aria-hidden />
      <span className="flex-1 text-sm font-semibold">
        {count} {count === 1 ? "listing" : "listings"} to pull from the bins
      </span>
      <span className="flex shrink-0 items-center text-sm font-medium text-danger">
        Start pulling
        <ChevronRight className="size-4" aria-hidden />
      </span>
    </Link>
  );
}
