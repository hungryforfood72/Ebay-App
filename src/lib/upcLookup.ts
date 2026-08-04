// UPCitemdb's trial endpoint works without a key, capped at 100 lookups/day.
// If that limit becomes a problem, switch to the paid endpoint and add
// UPC_LOOKUP_API_KEY (see .env.example).
export async function lookupUpc(upc: string): Promise<unknown> {
  const res = await fetch(
    `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`
  );
  if (!res.ok) {
    throw new Error(`UPC lookup failed with status ${res.status}`);
  }
  return res.json();
}
