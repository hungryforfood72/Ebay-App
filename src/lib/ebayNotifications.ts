import { createHash, createPublicKey, randomBytes, verify } from "crypto";
import {
  createNotificationDestination,
  createNotificationSubscription,
  getNotificationDestinations,
  getNotificationPublicKey,
  getNotificationSchemaVersion,
  getNotificationSubscriptions,
  hasEbayScope,
  NOTIFICATION_SUBSCRIPTION_SCOPE,
  testNotificationSubscription,
  updateNotificationDestination,
  updateNotificationSubscription,
} from "./ebay";
import { prisma } from "./prisma";

// eBay's instant sale alert: ORDER_CONFIRMATION fires for the seller once a
// buyer has checked out and paid. The alert is only a wake-up call: the
// notification route runs the normal order sync, which reads the order from
// eBay itself, so nothing in the alert body is trusted beyond the order id
// it names. The 10-minute cron still runs either way, so a missed alert
// costs minutes, not a double sale.
export const SALE_ALERT_TOPIC = "ORDER_CONFIRMATION";

const ENDPOINT_KEY = "ebay.notifications.endpoint";
const TOKEN_KEY = "ebay.notifications.verificationToken";
const SUBSCRIPTION_KEY = "ebay.notifications.subscriptionId";
const LAST_RECEIVED_KEY = "ebay.notifications.lastReceived";
const PUBLIC_KEY_PREFIX = "ebay.notifications.publicKey.";

async function getSetting(key: string): Promise<string | null> {
  return (await prisma.appSetting.findUnique({ where: { key } }))?.value ?? null;
}

async function putSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

// eBay checks a destination by calling it with ?challenge_code=... and
// expecting sha256(challengeCode + verificationToken + endpoint), hex. The
// endpoint has to be the exact string the destination was registered with.
export async function challengeResponse(challengeCode: string): Promise<string | null> {
  const [token, endpoint] = await Promise.all([getSetting(TOKEN_KEY), getSetting(ENDPOINT_KEY)]);
  if (!token || !endpoint) return null;
  return createHash("sha256").update(challengeCode).update(token).update(endpoint).digest("hex");
}

// X-EBAY-SIGNATURE is base64 JSON: { alg, kid, signature, digest }. The
// signature is ECDSA over the raw body, checked against eBay's public key
// for that kid. Keys never change for a given kid, so each is fetched once.
export async function verifyNotificationSignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      kid?: string;
      signature?: string;
      digest?: string;
    };
    if (!parsed.kid || !parsed.signature) return false;
    const pem = await publicKeyPem(parsed.kid);
    const algorithm = (parsed.digest ?? "SHA1").toLowerCase().replace("-", "");
    return verify(algorithm, Buffer.from(rawBody, "utf8"), createPublicKey(pem), Buffer.from(parsed.signature, "base64"));
  } catch (e) {
    console.error("[ebayNotifications] signature check failed", e);
    return false;
  }
}

async function publicKeyPem(kid: string): Promise<string> {
  const cacheKey = `${PUBLIC_KEY_PREFIX}${kid}`;
  const cached = await getSetting(cacheKey);
  if (cached) return cached;
  const { key } = await getNotificationPublicKey(kid);
  // eBay returns the PEM on one line; Node wants the base64 body on its own
  // lines between the markers.
  const body = key
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const pem = `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----\n`;
  await putSetting(cacheKey, pem);
  return pem;
}

export async function recordAlertReceived(info: { verified: boolean; orderId: string | null; test: boolean }): Promise<void> {
  await putSetting(LAST_RECEIVED_KEY, JSON.stringify({ at: new Date().toISOString(), ...info }));
}

export type SaleAlertStatus = {
  hasScope: boolean;
  endpoint: string | null;
  subscriptionStatus: string | null;
  lastReceived: { at: string; verified: boolean; orderId: string | null; test: boolean } | null;
};

export async function getSaleAlertStatus(): Promise<SaleAlertStatus> {
  const [hasScope, endpoint, lastReceivedRaw] = await Promise.all([
    hasEbayScope(NOTIFICATION_SUBSCRIPTION_SCOPE),
    getSetting(ENDPOINT_KEY),
    getSetting(LAST_RECEIVED_KEY),
  ]);
  let subscriptionStatus: string | null = null;
  if (hasScope) {
    try {
      subscriptionStatus = (await getNotificationSubscriptions()).find((s) => s.topicId === SALE_ALERT_TOPIC)?.status ?? null;
    } catch (e) {
      console.error("[ebayNotifications] reading subscriptions failed", e);
    }
  }
  return {
    hasScope,
    endpoint,
    subscriptionStatus,
    lastReceived: lastReceivedRaw ? JSON.parse(lastReceivedRaw) : null,
  };
}

// Turns sale alerts on, or repairs them: safe to run again any time (a new
// domain, a disabled subscription). Ends with eBay's own test alert, which
// shows up as "last alert received" in Settings when the round trip works.
export async function setUpSaleAlerts(endpoint: string): Promise<void> {
  if (!(await hasEbayScope(NOTIFICATION_SUBSCRIPTION_SCOPE))) {
    throw new Error("Reconnect eBay in Settings first: sale alerts need one more eBay permission.");
  }
  // Saved before eBay is asked to register the destination: eBay calls the
  // endpoint with its challenge during that request.
  let token = await getSetting(TOKEN_KEY);
  if (!token) {
    token = randomBytes(32).toString("hex");
    await putSetting(TOKEN_KEY, token);
  }
  await putSetting(ENDPOINT_KEY, endpoint);

  // Only ever this app's own destination (matched by endpoint). Any other
  // destination on the keyset is left alone; eBay allows several.
  const destination = (await getNotificationDestinations()).find((d) => d.endpoint === endpoint);
  if (destination && destination.status !== "ENABLED") {
    await updateNotificationDestination(destination.destinationId, endpoint, token);
  }
  const destinationId = destination?.destinationId ?? (await createNotificationDestination(endpoint, token));

  const schemaVersion = await getNotificationSchemaVersion(SALE_ALERT_TOPIC);
  const existing = (await getNotificationSubscriptions()).find((s) => s.topicId === SALE_ALERT_TOPIC);
  let subscriptionId: string;
  if (existing) {
    subscriptionId = existing.subscriptionId;
    if (existing.status !== "ENABLED" || existing.destinationId !== destinationId) {
      await updateNotificationSubscription(subscriptionId, destinationId, schemaVersion);
    }
  } else {
    subscriptionId = await createNotificationSubscription(SALE_ALERT_TOPIC, destinationId, schemaVersion);
  }
  await putSetting(SUBSCRIPTION_KEY, subscriptionId);
  await testNotificationSubscription(subscriptionId);
}
