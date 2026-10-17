"use client";

import { Badge } from "@/components/ui/Badge";
import { formatLocation } from "@/lib/warehouse/location";
import type { ItemLocation } from "@/lib/warehouse/types";
import { useEffect, useState } from "react";

// Where an item is, as a badge: "Shelf A5 · BN0042" for warehouse-mode
// items (one per bin), "Shelf A3" for items listed before warehouse mode,
// exactly as these badges always read. `fallbackShelf` covers a response
// that came back without a location (Item.shelfLocation).
export function LocationBadge({
  location,
  fallbackShelf,
}: {
  location: ItemLocation | null | undefined;
  fallbackShelf?: string | null;
}) {
  if (!location) return <Badge>{fallbackShelf ? `Shelf ${fallbackShelf}` : "No location"}</Badge>;
  if (location.bins.length === 0) {
    return <Badge>{location.legacyShelf ? `Shelf ${location.legacyShelf}` : formatLocation(location)}</Badge>;
  }
  return (
    <>
      {location.bins.map((b) => (
        <Badge key={b.binCode} tone={b.shelfLabel ? "neutral" : "warning"}>
          {formatLocation({ bins: [b], legacyShelf: null })}
        </Badge>
      ))}
    </>
  );
}

// For pages whose item list doesn't carry locations (Review, fed by
// GET /api/items): each badge asks for its own item, and the asks made in
// the same moment go out as one POST /api/bins/locations instead of one
// request per card.
let queued = new Map<string, ((loc: ItemLocation | null) => void)[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  const batch = queued;
  queued = new Map();
  flushTimer = null;
  fetch("/api/bins/locations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemIds: [...batch.keys()] }),
  })
    .then((r) => (r.ok ? r.json() : { locations: {} }))
    .catch(() => ({ locations: {} }))
    .then((data: { locations?: Record<string, ItemLocation> }) => {
      for (const [id, callbacks] of batch) callbacks.forEach((cb) => cb(data.locations?.[id] ?? null));
    });
}

function requestLocation(itemId: string): Promise<ItemLocation | null> {
  return new Promise((resolve) => {
    queued.set(itemId, [...(queued.get(itemId) ?? []), resolve]);
    flushTimer ??= setTimeout(flush, 30);
  });
}

export function FetchedLocationBadge({ itemId, shelfLocation }: { itemId: string; shelfLocation: string }) {
  const [location, setLocation] = useState<ItemLocation | null>(null);
  useEffect(() => {
    let cancelled = false;
    requestLocation(itemId).then((loc) => {
      if (!cancelled) setLocation(loc);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId]);
  // Until it loads (or if it fails), the old shelf badge, as before.
  // Warehouse-mode items have no shelf of their own (""), so nothing
  // shows for them until their bins come back.
  if (!location && !shelfLocation) return null;
  return <LocationBadge location={location} fallbackShelf={shelfLocation} />;
}
