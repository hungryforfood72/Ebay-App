// Expands a range like "A1-A50" or "A1-50" into ["A1", "A2", ..., "A50"].
// Falls back to treating the input as a single label if it doesn't look
// like a range (e.g. "A6", or a box size like "Small 6x4x2"). No
// zero-padding — "A1-A50" produces "A1", not "A01".
const RANGE_PATTERN = /^([A-Za-z]*)(\d+)\s*-\s*([A-Za-z]*)(\d+)$/;
const MAX_RANGE_SIZE = 500;

export function parseLocationRange(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const match = trimmed.match(RANGE_PATTERN);
  if (!match) return [trimmed];

  const [, prefix1, startStr, prefix2, endStr] = match;
  if (prefix1 && prefix2 && prefix1 !== prefix2) {
    // Prefixes disagree (e.g. "A1-B50") — not really a range.
    return [trimmed];
  }
  const prefix = prefix1 || prefix2;
  const start = Number(startStr);
  const end = Number(endStr);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return [trimmed];
  }
  if (end - start + 1 > MAX_RANGE_SIZE) {
    throw new Error(`That range covers ${end - start + 1} locations — max is ${MAX_RANGE_SIZE}.`);
  }

  const labels: string[] = [];
  for (let n = start; n <= end; n++) labels.push(`${prefix}${n}`);
  return labels;
}
