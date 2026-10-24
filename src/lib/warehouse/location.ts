import type { ItemLocation } from "./types";

// One line for a badge: "Shelf A5 · BN0042", "BN0042 (not shelved)",
// "Oversized shelf A5" (no bin), "Shelf A5" for older items, or "Not in a bin yet" (labeled at the listing
// station, waiting at the binning station). Client-safe.
export function formatLocation(loc: ItemLocation | null | undefined): string {
  if (!loc) return "No location";
  if (loc.bins.length === 0) return loc.legacyShelf ? `Shelf ${loc.legacyShelf}` : "Not in a bin yet";
  return loc.bins
    .map((b) =>
      b.oversized
        ? `Oversized shelf ${b.shelfLabel}`
        : b.shelfLabel
          ? `Shelf ${b.shelfLabel} · ${b.binCode}`
          : `${b.binCode} (not shelved)`
    )
    .join(", ");
}
