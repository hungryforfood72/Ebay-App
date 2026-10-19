import type { Prisma } from "@/generated/prisma/client";
import { getRequestUser, type AuthedUser } from "./auth";
import { prisma } from "./prisma";

// The activity log (ActivityLog in schema.prisma): who did what, and what
// it was before. Writing a row never throws: a logging problem must never
// stop the action it's logging. Server only.

// Never stored, at any depth of what was sent.
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|signature|authorization/i;
// A request body bigger than this is cut down (photo data never comes
// through the app, so real bodies are small).
const MAX_BODY_CHARS = 6000;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[hidden]" : redact(v, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || null;
}

type Entry = {
  action: string;
  summary: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
};

function json(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  const cleaned = redact(JSON.parse(JSON.stringify(value)));
  const text = JSON.stringify(cleaned);
  return (text.length > MAX_BODY_CHARS ? { truncated: text.slice(0, MAX_BODY_CHARS) } : cleaned) as Prisma.InputJsonValue;
}

export async function logActivity(
  who: { request?: Request; user?: AuthedUser | null; username?: string | null },
  entry: Entry & { method?: string | null; path?: string | null }
): Promise<void> {
  try {
    const user = who.user ?? (who.request ? getRequestUser(who.request) : null);
    await prisma.activityLog.create({
      data: {
        username: user?.username ?? who.username ?? null,
        role: user?.role ?? null,
        action: entry.action,
        summary: entry.summary.slice(0, 500),
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        before: json(entry.before),
        after: json(entry.after),
        method: entry.method ?? (who.request ? who.request.method : null),
        path: entry.path ?? (who.request ? new URL(who.request.url).pathname : null),
        ip: who.request ? clientIp(who.request) : null,
      },
    });
  } catch (e) {
    console.error("[activityLog]", e);
  }
}

// The fields that actually changed between two snapshots of a record, as
// { before, after } with only those keys. Dates and decimals compared as
// text.
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const text = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v));
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (text(before[key]) !== text(after[key])) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

// Paths whose calls aren't worth a row: machines checking in many times a
// minute, or lookups that only read through a POST.
const QUIET_REQUESTS: RegExp[] = [
  /^\/api\/stations\/[^/]+\/heartbeat$/,
  /^\/api\/print-jobs\/[^/]+$/, // the station reporting printed/failed
  /^\/api\/cloudinary-signature$/,
  /^\/api\/pack-suggestion$/,
  /^\/api\/items\/[^/]+\/category-lookup$/,
  /^\/api\/returns\/advice$/,
  /^\/api\/auth$/, // logged by the route itself, with the outcome
  // Shipping label uploads carry buyer addresses (page text, page images):
  // the upload route logs its own row without them.
  /^\/api\/ship\/labels\/match$/,
  /^\/api\/ship\/labels$/,
];

// proxy.ts: one "request" row per data-changing API call by a signed-in
// user. Runs after the response is on its way.
export async function logRequest(request: Request, user: AuthedUser): Promise<void> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  if (!path.startsWith("/api/") || QUIET_REQUESTS.some((p) => p.test(path))) return;
  let body: unknown = undefined;
  try {
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { text: text.slice(0, 300) };
      }
    }
  } catch {
    // No readable body; the call itself is still worth a row.
  }
  await logActivity({ user, request }, { action: "request", summary: `${request.method} ${path}`, after: body, method: request.method, path });
}
