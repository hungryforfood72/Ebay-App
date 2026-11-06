import { syncEbaySales } from "@/lib/channelSync";
import { challengeResponse, recordAlertOutcome, recordAlertReceived, verifyNotificationSignature } from "@/lib/ebayNotifications";
import { after, NextRequest, NextResponse } from "next/server";

export const maxDuration = 180;

// eBay's instant sale alerts (ORDER_CONFIRMATION, see ebayNotifications.ts).
// Signed-out by design (exempted in proxy.ts): eBay's signature is the gate.

// eBay's endpoint check, run when the destination is registered.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("challenge_code");
  if (!code) return NextResponse.json({ error: "Missing challenge_code." }, { status: 400 });
  const challenge = await challengeResponse(code);
  if (!challenge) return NextResponse.json({ error: "Sale alerts aren't set up." }, { status: 404 });
  return NextResponse.json({ challengeResponse: challenge });
}

// The alert itself. Answered right away (eBay retries anything slow), then
// the normal quick order sync runs, which records the sale and brings the
// Shopify count down. The order id only tells it which order to fetch
// directly, in case eBay's order search hasn't caught up yet.
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const verified = await verifyNotificationSignature(raw, request.headers.get("x-ebay-signature"));
  let orderId: string | null = null;
  let test = false;
  try {
    const body = JSON.parse(raw) as {
      notification?: { notificationId?: string; data?: { order?: { orderId?: string } } };
    };
    orderId = body.notification?.data?.order?.orderId ?? null;
    // testSubscription's mock payload; it names no real order.
    test = !orderId || /test/i.test(body.notification?.notificationId ?? "");
  } catch {
    // Not JSON: treated as unverified below.
  }
  await recordAlertReceived({ verified, orderId, test });
  // eBay's docs: 412 tells it the payload failed verification.
  if (!verified) return new NextResponse(null, { status: 412 });

  after(async () => {
    const wanted = orderId && !test ? orderId : null;
    const startedAt = Date.now();
    const errors: string[] = [];
    let attempts = 0;
    let seen = !wanted;
    // The alert lands about a second after the sale. If that run doesn't
    // get to the order (eBay not showing it yet, another sync holding the
    // lock, a hiccup), go again shortly instead of leaving it to the
    // 10-minute cron, so the Shopify count comes down within seconds.
    for (;;) {
      attempts++;
      try {
        const result = await syncEbaySales("quick", wanted ? [wanted] : []);
        const runErrors = [...result.ebay.flatMap((r) => r.errors), ...(result.shopify?.errors ?? [])];
        errors.push(...runErrors);
        if (wanted) {
          seen =
            result.ran &&
            result.ebay.some((r) => r.orderIdsSeen.includes(wanted)) &&
            !runErrors.some((e) => e.includes(wanted) || e.startsWith("Fetching orders failed"));
        }
      } catch (e) {
        // A database hiccup taking the sync lock: try again, don't give up.
        errors.push(`Attempt ${attempts}: ${e instanceof Error ? e.message : String(e)}`);
      }
      // No new attempt late in the run: one can take a while, and a run cut
      // off at maxDuration would leave the sync locks held for minutes.
      if (seen || attempts >= ALERT_ATTEMPTS || Date.now() - startedAt > ALERT_LAST_START_MS) break;
      await new Promise((r) => setTimeout(r, ALERT_RETRY_WAIT_MS));
    }
    if (errors.length) console.error("[ebay notification] sync errors", errors);
    await recordAlertOutcome({
      at: new Date(startedAt).toISOString(),
      orderId: wanted,
      attempts,
      seen,
      recordedMs: Date.now() - startedAt,
      errors: errors.slice(0, 5).map((e) => e.slice(0, 300)),
    }).catch((e) => console.error("[ebay notification] outcome not saved", e));
  });
  return new NextResponse(null, { status: 204 });
}

// Up to 5 tries, 10s apart, none starting after 60s, well inside the 180s
// function limit.
const ALERT_ATTEMPTS = 5;
const ALERT_RETRY_WAIT_MS = 10_000;
const ALERT_LAST_START_MS = 50_000;
