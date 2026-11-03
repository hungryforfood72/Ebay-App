import { timingSafeEqual } from "node:crypto";

// Vercel Cron (and sourcingRun's self-continuation) send
// `Authorization: Bearer $CRON_SECRET`. Fails closed when the secret isn't
// set (never compares against "Bearer undefined"), and compares in
// constant time.
export function isCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
