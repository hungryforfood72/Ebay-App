// "12/2026" from a Date or ISO date string — expiration on packaging is
// usually month/year, and this is the format used both in bundle manifests
// and the CSV's C:Expiration Date item specific.
export function formatExpiration(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
