import { formatExpiration } from "./formatExpiration";

// Several expiration dates on one listing, for a pack whose units came in
// with different dates (Cristian, 2026-10-15: Lizvet had been making those
// into bundles). The listing goes by the oldest date everywhere a single
// date is needed (eBay's Expiration Date specific, the title, the expiring
// list, the sweep); the description lists every date with its unit count.
export type ExpirationBatch = { date: string; units: number };

// Cleans what the scan page sends: real dates, whole units, same dates
// merged, oldest first. null when it's down to one date (or none), since
// then expirationDate alone says everything.
// Throws on a row without a real date or with fewer than 1 unit.
export function normalizeBreakdown(value: unknown): ExpirationBatch[] | null {
  if (!Array.isArray(value)) return null;
  const byDate = new Map<string, number>();
  for (const row of value) {
    const date = typeof row?.date === "string" ? row.date.slice(0, 10) : "";
    const units = Math.floor(Number(row?.units));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime()) || !(units >= 1)) {
      throw new Error("Every expiration date needs a real date and at least 1 unit.");
    }
    byDate.set(date, (byDate.get(date) ?? 0) + units);
  }
  const batches = [...byDate.entries()].map(([date, units]) => ({ date, units })).sort((a, b) => a.date.localeCompare(b.date));
  return batches.length > 1 ? batches : null;
}

function unitsLabel(units: number): string {
  return `${units} unit${units === 1 ? "" : "s"}`;
}

// "2 units 03/15/2027, 1 unit 06/01/2027"
export function describeBreakdown(batches: ExpirationBatch[]): string {
  return batches.map((b) => `${unitsLabel(b.units)} ${formatExpiration(b.date)}`).join(", ");
}

// Added to the end of the drafted description, the same way a bundle's
// per-item dates are, so the counts and dates are exact rather than
// retyped by the model. A plain-text section, laid out with the rest of
// the description by listingDescription.ts (2026-10-25).
export function breakdownDescriptionText(batches: ExpirationBatch[]): string {
  return [
    "Expiration dates:",
    "The units in this listing don't all share one date:",
    ...batches.map((b) => `- ${unitsLabel(b.units)}: Best by ${formatExpiration(b.date)}`),
  ].join("\n");
}

// The older HTML version, for a description that's already HTML.
export function breakdownDescriptionHtml(batches: ExpirationBatch[]): string {
  const rows = batches.map((b) => `<li>${unitsLabel(b.units)}: Best by ${formatExpiration(b.date)}</li>`).join("");
  return `<p>The units in this listing have different expiration dates:</p><ul>${rows}</ul>`;
}

export type ExpirySplit = {
  pastDate: ExpirationBatch[];
  stillGood: ExpirationBatch[];
  // false for what the past-date deals page never takes (OTC medicine,
  // sunscreen, baby formula/food): those units are pulled, not resold.
  pastDateLane?: boolean;
};

// For the expiration sweep: the batches at or inside the removal cutoff vs
// the ones still good after it. null unless it's really both.
export function splitAtCutoff(breakdown: unknown, cutoff: Date): ExpirySplit | null {
  let batches: ExpirationBatch[] | null;
  try {
    batches = normalizeBreakdown(breakdown);
  } catch {
    return null;
  }
  if (!batches) return null;
  const pastDate = batches.filter((b) => new Date(b.date) <= cutoff);
  const stillGood = batches.filter((b) => new Date(b.date) > cutoff);
  return pastDate.length > 0 && stillGood.length > 0 ? { pastDate, stillGood } : null;
}
