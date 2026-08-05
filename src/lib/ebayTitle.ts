// eBay hard-rejects listing titles over 80 characters ("Error - Listing
// titles are limited to 80 characters"). Cuts at the last word boundary
// within the limit when there is one nearby, so a truncated title still
// reads cleanly rather than ending mid-word.
export function truncateTitle(title: string, max = 80): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only back off to the word boundary if it doesn't throw away too much.
  if (lastSpace > max - 15) return cut.slice(0, lastSpace);
  return cut;
}
