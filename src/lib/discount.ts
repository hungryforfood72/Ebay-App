// Shared by the manifest bulk-discount route and the single-item discount
// route — the $0.99 floor is a correctness constant worth keeping in one
// place, even though the two routes' surrounding logic (loop over a
// manifest vs. act on one item) differs enough to stay separate.
export function computeDiscountedPrice(currentPrice: number, mode: "percent" | "amount", value: number): number {
  const raw = mode === "percent" ? currentPrice * (1 - value / 100) : currentPrice - value;
  return Math.max(raw, 0.99);
}
