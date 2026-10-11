import { syncEbaySales } from "@/lib/channelSync";
import { challengeResponse, recordAlertReceived, verifyNotificationSignature } from "@/lib/ebayNotifications";
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
    const result = await syncEbaySales("quick", orderId && !test ? [orderId] : []);
    const errors = [...result.ebay.flatMap((r) => r.errors), ...(result.shopify?.errors ?? [])];
    if (errors.length) console.error("[ebay notification] sync errors", errors);
  });
  return new NextResponse(null, { status: 204 });
}
