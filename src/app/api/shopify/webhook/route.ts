import { verifyShopifyWebhook } from "@/lib/shopify";
import { runShopifySync } from "@/lib/shopifySync";
import { after, NextRequest, NextResponse } from "next/server";

export const maxDuration = 120;

// Shopify order webhooks (new order, cancellation, refund), Whatnot sales
// included, since Whatnot's Shopify app writes them in as Shopify orders.
// Signed-out by design (exempted in proxy.ts); the HMAC check is the gate.
// The payload itself isn't used: the order sync reads the orders straight
// from the API, so this only has to say "something changed, go look".
// Shopify wants an answer within 5 seconds, so the work runs after the
// response.
export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (!verifyShopifyWebhook(raw, request.headers.get("x-shopify-hmac-sha256"))) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }
  after(async () => {
    const result = await runShopifySync({ items: [] });
    if (result.errors.length) console.error("[shopify webhook] sync errors", result.errors);
  });
  return NextResponse.json({ ok: true });
}
