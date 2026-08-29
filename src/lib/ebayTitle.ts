// A trailing "Exp"/"BB" ("Best By") with the actual date truncated off after
// it reads as if the title just forgot to finish — e.g. "...36 Sticks Exp"
// or "...Drink Mix 54 Pack BB" on a real live listing. Drop the dangling
// marker itself rather than leave it hanging with nothing after it.
const DANGLING_DATE_MARKER = /\s+(?:Exp\.?|Expires?|Best(?:\s+By)?|BB)\.?$/i;

// eBay hard-rejects listing titles over 80 characters ("Error - Listing
// titles are limited to 80 characters"). Cuts at the last word boundary
// within the limit when there is one nearby, so a truncated title still
// reads cleanly rather than ending mid-word.
export function truncateTitle(title: string, max = 80): string {
  let result = title;
  if (title.length > max) {
    const cut = title.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    // Only back off to the word boundary if it doesn't throw away too much.
    result = lastSpace > max - 15 ? cut.slice(0, lastSpace) : cut;
  }
  return result.replace(DANGLING_DATE_MARKER, "");
}
