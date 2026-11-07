// The photo-vs-barcode check (schema: Item.barcodeMismatch). Safe to import
// from client components.

export const BARCODE_MISMATCH_CLEARED = "Cleared";

// Flagged and not cleared: can't be marked ready or published anywhere.
export function barcodeMismatchBlocks(note: string | null | undefined): boolean {
  return Boolean(note) && !note!.startsWith(BARCODE_MISMATCH_CLEARED);
}

// Prisma filter for items that aren't held back by it. Spelled out as
// null-or-cleared: "not flagged" in SQL would drop the nulls.
export const BARCODE_OK_WHERE = {
  OR: [{ barcodeMismatch: null }, { barcodeMismatch: { startsWith: BARCODE_MISMATCH_CLEARED } }],
};
