// Loose barcode matching for supplier spreadsheets, which mangle UPCs:
// Excel drops leading zeros, some sheets lose the check digit (and the
// importer's fix can then append a wrong one), some carry case codes, and
// a few store the real 12-digit UPC with extra digits in front (seen on
// the Medical Supplies manifest: 130382903051060 for UPC 382903051060).
// Two codes match when any of their keys match. Keys ignore leading zeros
// and the check digit, and a 14-digit case code (GTIN-14) also keys to the
// UPC it packs. Within one manifest the looseness can't realistically
// collide two different products.
const stripZeros = (s: string) => s.replace(/^0+/, "");

export function upcMatchKeys(code: string | null | undefined): string[] {
  const d = (code ?? "").replace(/\D/g, "");
  if (d.length < 6) return [];
  const keys = new Set<string>([stripZeros(d), stripZeros(d.slice(0, -1))]);
  if (d.length > 12) {
    keys.add(stripZeros(d.slice(-12)));
    keys.add(stripZeros(d.slice(-12, -1)));
  }
  if (d.length === 14) keys.add(stripZeros(d.slice(1, -1)));
  keys.delete("");
  return [...keys];
}
