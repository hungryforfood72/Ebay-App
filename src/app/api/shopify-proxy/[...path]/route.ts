import { createHmac, timingSafeEqual } from "crypto";
import { isBrowserSubscription, removeSubscription, saveSubscription, vapidPublicKey } from "@/lib/dealAlerts";
import { getShopifyConfig } from "@/lib/shopify";
import { NextRequest, NextResponse } from "next/server";

// The Shopify app proxy: the store's /apps/deals/* is forwarded here, so
// the deal-alerts service worker and sign-up run at the store's own
// address (a service worker has to). Signed-out by design (exempted in
// proxy.ts); every request is checked against Shopify's app proxy
// signature instead.
//   GET  /apps/deals/sw.js        the service worker
//   GET  /apps/deals/config       { publicKey } for subscribing
//   POST /apps/deals/subscribe    { subscription }
//   POST /apps/deals/unsubscribe  { endpoint }

// Shopify signs proxied requests: every query param except `signature`,
// as "key=value" (repeated keys joined with ","), sorted, concatenated with
// nothing between, HMAC-SHA256 with the app's client secret, hex.
function signedByShopify(request: NextRequest): boolean {
  const secret = getShopifyConfig()?.clientSecret;
  const signature = request.nextUrl.searchParams.get("signature");
  if (!secret || !signature) return false;
  const grouped = new Map<string, string[]>();
  for (const [key, value] of request.nextUrl.searchParams) {
    if (key === "signature") continue;
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  const message = [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .sort()
    .join("");
  const expected = createHmac("sha256", secret).update(message).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Shows each alert and opens the store page it points at when tapped. Its
// scope is /apps/deals/ (Shopify won't pass the header a wider scope
// needs), which is fine: push doesn't need it to control any page.
const SERVICE_WORKER = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "Epic Steals", {
      body: data.body || "New deals just dropped.",
      icon: data.icon,
      badge: data.icon,
      tag: data.tag,
      data: { url: data.url || "/" },
    })
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow((event.notification.data && event.notification.data.url) || "/"));
});
`;

type Params = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, { params }: Params) {
  if (!signedByShopify(request)) return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  const path = (await params).path.join("/");
  if (path === "sw.js") {
    return new NextResponse(SERVICE_WORKER, {
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }
  if (path === "config") {
    return NextResponse.json({ publicKey: await vapidPublicKey() }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function POST(request: NextRequest, { params }: Params) {
  if (!signedByShopify(request)) return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  const path = (await params).path.join("/");
  const body = await request.json().catch(() => null);
  if (path === "subscribe") {
    if (!isBrowserSubscription(body?.subscription)) {
      return NextResponse.json({ error: "That isn't a push subscription." }, { status: 400 });
    }
    await saveSubscription(body.subscription, request.headers.get("user-agent")?.slice(0, 300) ?? null);
    return NextResponse.json({ ok: true });
  }
  if (path === "unsubscribe") {
    if (typeof body?.endpoint === "string") await removeSubscription(body.endpoint);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}
