import webpush from "web-push";
import { prisma } from "./prisma";
import { getShopifyConfig, shopifyGraphql } from "./shopify";

// Epic Steals deal alerts: web push notifications to shoppers who tapped
// "Get deal alerts" on the store (on iPhone, only inside the installed
// home-screen app; Apple allows web push nowhere else). The store reaches
// this app through the Shopify app proxy at /apps/deals (see
// /api/shopify-proxy), which serves the service worker from the store's
// own address. Free to send: the push services (Google, Apple, Mozilla)
// don't charge.

// The VAPID key pair identifies this app to the push services. Made once
// and kept in the database rather than an env var, so there's no secret to
// copy anywhere; changing it would orphan every existing subscription.
const VAPID_KEY = "push.vapid";

async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const row = await prisma.appSetting.findUnique({ where: { key: VAPID_KEY } });
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  // create, not upsert: if two requests race, the second fails here and
  // re-reads the first one's keys instead of replacing them.
  try {
    await prisma.appSetting.create({ data: { key: VAPID_KEY, value: JSON.stringify(keys) } });
    return keys;
  } catch {
    const again = await prisma.appSetting.findUniqueOrThrow({ where: { key: VAPID_KEY } });
    return JSON.parse(again.value);
  }
}

export async function vapidPublicKey(): Promise<string> {
  return (await vapidKeys()).publicKey;
}

export type BrowserSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };

export function isBrowserSubscription(value: unknown): value is BrowserSubscription {
  const v = value as BrowserSubscription | null;
  return (
    typeof v?.endpoint === "string" &&
    v.endpoint.startsWith("https://") &&
    typeof v.keys?.p256dh === "string" &&
    typeof v.keys?.auth === "string"
  );
}

export async function saveSubscription(sub: BrowserSubscription, userAgent: string | null): Promise<void> {
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent },
    update: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent },
  });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
}

// The store's public address (epic-steals.com), for the link each alert
// opens. Read from Shopify once and kept.
const STORE_URL_KEY = "shopify.primaryUrl";

async function storeUrl(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: STORE_URL_KEY } });
  if (row) return row.value;
  const data = await shopifyGraphql<{ shop: { primaryDomain: { url: string } } }>(`{ shop { primaryDomain { url } } }`);
  const url = data.shop.primaryDomain.url.replace(/\/+$/, "");
  await prisma.appSetting.upsert({ where: { key: STORE_URL_KEY }, create: { key: STORE_URL_KEY, value: url }, update: { value: url } });
  return url;
}

// The Epic Steals box icon, served from this app's public/icons (exempt
// from the sign-in gate in proxy.ts).
const ICON_URL = "https://ebay-app-iota.vercel.app/icons/epic-steals-192.png";

export type Alert = { title: string; body: string; path: string; tag: string };
export type SendResult = { sent: number; removed: number; failed: number };

export async function sendToAll(alert: Alert): Promise<SendResult> {
  const result: SendResult = { sent: 0, removed: 0, failed: 0 };
  if (!getShopifyConfig()) return result;
  const [keys, base, subs] = await Promise.all([vapidKeys(), storeUrl(), prisma.pushSubscription.findMany()]);
  const payload = JSON.stringify({ title: alert.title, body: alert.body, url: `${base}${alert.path}`, icon: ICON_URL, tag: alert.tag });
  const options = {
    vapidDetails: { subject: base, publicKey: keys.publicKey, privateKey: keys.privateKey },
    // A phone that's off for a while still gets it within a day; after
    // that a deal alert is stale.
    TTL: 24 * 60 * 60,
  };
  for (let i = 0; i < subs.length; i += 20) {
    await Promise.all(
      subs.slice(i, i + 20).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options);
          await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastSentAt: new Date() } });
          result.sent++;
        } catch (e) {
          // 404/410: the device unsubscribed or the app was removed.
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
            result.removed++;
          } else {
            result.failed++;
            console.error("[dealAlerts] send failed", status, e);
          }
        }
      })
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// The two alerts Cristian picked
// ---------------------------------------------------------------------------

const NEW_DEALS_SINCE_KEY = "push.newDealsSince";
// Not worth a ping for one or two items; they roll into the next day.
const MIN_NEW_DEALS = 3;

// Once a day (the hourly cron calls this in the 6 PM Chicago hour): how
// many items went up on the store since the last new-deals alert. Past-date
// items have their own alert and don't count.
export async function sendNewDealsAlert(now: Date = new Date()): Promise<{ count: number; result: SendResult | null }> {
  const row = await prisma.appSetting.findUnique({ where: { key: NEW_DEALS_SINCE_KEY } });
  const since = row ? new Date(row.value) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const count = await prisma.item.count({
    where: { shopifyPublishedAt: { gt: since, lte: now }, pastDateAt: null, shopifyArchivedAt: null },
  });
  if (count < MIN_NEW_DEALS) return { count, result: null };
  const result = await sendToAll({
    title: `${count} new steals just dropped`,
    body: "Brand-name deals in limited stock. Tap to shop them before they're gone.",
    path: "/collections/all?sort_by=created-descending",
    tag: "new-deals",
  });
  await prisma.appSetting.upsert({
    where: { key: NEW_DEALS_SINCE_KEY },
    create: { key: NEW_DEALS_SINCE_KEY, value: now.toISOString() },
    update: { value: now.toISOString() },
  });
  return { count, result };
}

// Right after the 8 PM expiry check moves items onto the past-date page.
export async function sendPastDateAlert(count: number): Promise<SendResult | null> {
  if (count <= 0) return null;
  return sendToAll({
    title: count === 1 ? "1 item just hit the past-date page" : `${count} items just hit the past-date page`,
    body: "Short-dated deals at an extra 65% off our prices. Every date is shown.",
    path: "/collections/past-date-deals",
    tag: "past-date",
  });
}

export async function subscriberCount(): Promise<number> {
  return prisma.pushSubscription.count();
}
