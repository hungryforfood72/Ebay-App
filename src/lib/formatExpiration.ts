// "12/25/2026" from a Date or ISO date string. Used for both bundle
// manifests and the CSV's C:Expiration Date item specific — this used to
// drop the day (month/year only), but eBay pulled a real listing over the
// mismatch between the full date in the description ("Best by 09/21/2026")
// and the day-less C:Expiration Date specific ("09/2026"), so this needs to
// carry the exact date the scan flow already captured, not a rounded one.
export function formatExpiration(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${d.getUTCFullYear()}`;
}
