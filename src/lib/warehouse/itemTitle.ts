// The name to show for an item on a warehouse screen (bins, pick list).
// The final/AI titles don't exist until the draft runs, so a freshly binned
// item falls back to the UPC lookup's product name, then the UPC itself.
export function itemDisplayTitle(item: {
  finalTitle: string | null;
  aiTitle: string | null;
  upcLookupData: unknown;
  upc: string | null;
  sku: string;
}): string {
  if (item.finalTitle) return item.finalTitle;
  if (item.aiTitle) return item.aiTitle;
  const lookup = item.upcLookupData as { items?: { title?: unknown }[] } | null;
  const lookupTitle = lookup?.items?.[0]?.title;
  if (typeof lookupTitle === "string" && lookupTitle.trim()) return lookupTitle.trim();
  return item.upc ? `UPC ${item.upc}` : item.sku;
}
