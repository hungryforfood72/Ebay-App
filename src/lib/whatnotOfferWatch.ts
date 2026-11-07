import { mailerConfigured, sendEmail } from "./mailer";
import { prisma } from "./prisma";

// Watching for offers in Whatnot's API (Cristian, 2026-11-07). Whatnot's
// buy-it-now listings can take offers ("Accept Offers" in Seller Hub, the
// Offerable column in its CSV), but the Seller API has no way to turn that
// on, see offers or answer them yet. He wants it built in once it can be,
// like eBay's buyer offers (the profit at each offer amount, accept/counter
// from the app). Once a day this reads Whatnot's public API and webhook
// specs; the first time anything about offers on listings shows up, he
// gets an email (retried until it goes) and the Whatnot page says what
// appeared.

const KEY = "whatnot.offerWatch";
const DAY_MS = 24 * 60 * 60 * 1000;
// Fixed, public URLs (never from a request). About 230KB and 125KB today.
const API_SPEC = "https://developers.whatnot.com/api-reference/openapi.json";
const WEBHOOK_SPEC = "https://developers.whatnot.com/webhooks/openapi.json";
const MAX_BYTES = 2_000_000;
// Already there on 2026-11-07, and not what he's waiting for: order lists
// leave out offers that were never accepted.
const KNOWN = new Set(["path:GET /orders"]);
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export type OfferWatch = {
  checkedAt: string | null;
  // What about offers showed up (empty = nothing yet), when first seen,
  // and which of them he's been emailed about.
  found: string[];
  foundAt: string | null;
  emailed: string[];
  emailedAt: string | null;
  error: string | null;
};

const EMPTY: OfferWatch = { checkedAt: null, found: [], foundAt: null, emailed: [], emailedAt: null, error: null };

function parseState(raw: string): OfferWatch {
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((f): f is string => typeof f === "string").slice(0, 50) : []);
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return EMPTY;
    const o = v as Record<string, unknown>;
    const checkedAt = str(o.checkedAt);
    return {
      // A time in the future would silence the watch for good.
      checkedAt: checkedAt && Date.parse(checkedAt) <= Date.now() ? checkedAt : null,
      found: list(o.found),
      foundAt: str(o.foundAt),
      emailed: list(o.emailed),
      emailedAt: str(o.emailedAt),
      error: str(o.error),
    };
  } catch {
    return EMPTY;
  }
}

export async function getOfferWatch(): Promise<OfferWatch> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  return row ? parseState(row.value) : EMPTY;
}

// Reads a spec with a byte cap counted as it streams in (a bad response
// can't fill memory first).
async function readSpec(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store", headers: { accept: "application/json" } });
  if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
    await res.body.cancel();
    throw new Error(`${url} is unexpectedly big`);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`${url} is unexpectedly big`);
    }
    chunks.push(value);
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${url} isn't a JSON object`);
  return parsed as Record<string, unknown>;
}

type Schema = { properties?: Record<string, { description?: string }>; description?: string };

// Anything about offers on a listing: an offers endpoint, an offers webhook
// topic, or an offer setting on a product, variant, price or sale format.
// Labels are cleaned and capped, since they're stored, shown and emailed.
export function offerMentions(apiSpec: Record<string, unknown>, webhookSpec: Record<string, unknown> | null): string[] {
  const found = new Set<string>();
  const paths = (apiSpec.paths ?? {}) as Record<string, Record<string, { summary?: string; description?: string }>>;
  for (const [path, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== "object") continue;
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method) || typeof op !== "object" || op == null) continue;
      if (/offer/i.test(path) || /offer/i.test(`${op.summary ?? ""} ${op.description ?? ""}`)) found.add(`path:${method.toUpperCase()} ${path}`);
    }
  }
  const schemas = ((apiSpec.components as { schemas?: Record<string, Schema> } | undefined)?.schemas ?? {}) as Record<string, Schema>;
  for (const [name, schema] of Object.entries(schemas)) {
    if (!/product|variant|merchandis|pricing|buyitnow|buy_it_now|listing|offer/i.test(name)) continue;
    if (/offer/i.test(name)) found.add(`schema:${name}`);
    for (const [prop, def] of Object.entries(schema?.properties ?? {})) {
      if (/offer/i.test(prop) || /offer/i.test(def?.description ?? "")) found.add(`field:${name}.${prop}`);
    }
  }
  const hooks = webhookSpec?.webhooks;
  if (hooks && typeof hooks === "object") {
    for (const topic of Object.keys(hooks)) if (/offer/i.test(topic)) found.add(`webhook:${topic}`);
  }
  return [...found]
    .filter((f) => !KNOWN.has(f))
    .map((f) => f.replace(/[^\w ./{}:_-]/g, "").slice(0, 120))
    .sort()
    .slice(0, 25);
}

function describe(f: string): string {
  const at = f.indexOf(":");
  const [kind, rest] = [f.slice(0, at), f.slice(at + 1)];
  if (kind === "path") return `New API call: ${rest}`;
  if (kind === "webhook") return `New webhook: ${rest}`;
  if (kind === "schema") return `New part of the API: ${rest}`;
  return `New listing setting: ${rest}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function emailOwner(found: string[]): Promise<boolean> {
  if (!mailerConfigured()) return false;
  const owners = await prisma.user.findMany({ where: { role: "owner", email: { not: null } }, select: { email: true } });
  const to = owners.map((o) => o.email!).filter(Boolean);
  if (to.length === 0 && process.env.EPIC_STEALS_GMAIL_USER) to.push(process.env.EPIC_STEALS_GMAIL_USER);
  if (to.length === 0) return false;
  const lines = found.map(describe);
  const head = "Whatnot's API now has something about offers. This is what you asked to be told about: offers on Whatnot buy-it-now listings, with the profit at each offer like eBay's.";
  const next = "Ask Claude to build it in (the eBay Tool's Whatnot page lists what showed up).";
  await sendEmail({
    to: to.join(", "),
    subject: "Whatnot's API has offers now",
    text: `${head}\n\n${lines.join("\n")}\n\n${next}`,
    html: `<p>${escapeHtml(head)}</p><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul><p>${escapeHtml(next)}</p>`,
  });
  return true;
}

// Once a day at most (the 4-hourly full sync calls it). Never throws.
export async function checkWhatnotOffers(): Promise<void> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    const state = row ? parseState(row.value) : EMPTY;
    if (state.checkedAt && Date.now() - new Date(state.checkedAt).getTime() < DAY_MS) return;
    // Claimed first (compare-and-swap on the stored value), so two runs at
    // once can't both check and both email.
    const claimed = JSON.stringify({ ...state, checkedAt: new Date().toISOString() });
    if (row) {
      const claim = await prisma.appSetting.updateMany({ where: { key: KEY, value: row.value }, data: { value: claimed } });
      if (claim.count !== 1) return;
    } else {
      try {
        await prisma.appSetting.create({ data: { key: KEY, value: claimed } });
      } catch {
        return; // another run made it first
      }
    }
    let next: OfferWatch = { ...state, checkedAt: new Date().toISOString() };
    try {
      const [api, hooks] = await Promise.all([readSpec(API_SPEC), readSpec(WEBHOOK_SPEC).catch(() => null)]);
      const found = offerMentions(api, hooks);
      const all = [...new Set([...state.found, ...found])].slice(0, 50);
      next = { ...next, found: all, foundAt: found.length && !state.foundAt ? new Date().toISOString() : state.foundAt, error: null };
      // Anything not emailed yet goes out (again tomorrow if the email fails).
      const pending = all.filter((f) => !state.emailed.includes(f));
      if (pending.length && (await emailOwner(pending).catch(() => false))) {
        next = { ...next, emailed: [...state.emailed, ...pending].slice(0, 50), emailedAt: new Date().toISOString() };
      }
    } catch (e) {
      next = { ...next, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
    }
    const value = JSON.stringify(next);
    await prisma.appSetting.update({ where: { key: KEY }, data: { value } });
  } catch (e) {
    console.error("[whatnot offer watch]", e);
  }
}
