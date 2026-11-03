import { createHash } from "node:crypto";
import { mailerConfigured, sendEmail } from "./mailer";
import { prisma } from "./prisma";

// Runaway-spend guard for every Claude call (Cristian, 2026-11-03: "if
// there's ever a bug at the start of the month I don't want to spend $1000
// on it"). Wired into the shared client's fetch in src/lib/anthropic.ts, so
// it covers every call site without each one opting in.
//
// Two checks before a request goes out:
//  1. Spend limits per hour, day and month (Chicago time), summed from
//     AiUsageLog. Crossing one PAUSES all AI until the owner taps Resume in
//     Settings: a bug can't keep spending next hour or tomorrow. The owner
//     gets an email with what made the calls, to tell a busy day from a bug.
//  2. Loop catcher: the exact same request body 9 times in 10 minutes is
//     refused. Real work never repeats itself that fast; a retry loop does.
//     Per server instance (in memory), so it catches loops inside one run.
// A refused call costs nothing: it never reaches Anthropic.
//
// The Console's own workspace spend limit is still the final backstop: it
// also covers calls this guard can't see (a leaked key, a call that timed
// out before its usage was logged).

export type GuardWindow = "hour" | "day" | "month";
export type GuardLimits = Record<GuardWindow, number>;
type WindowKeys = Record<GuardWindow, string>;
type Extra = Partial<Record<GuardWindow, { key: string; usd: number }>>;

export type GuardPause = {
  window: GuardWindow;
  windowKey: string;
  limitUsd: number;
  spentUsd: number;
  at: string;
  // Last 60 minutes by feature, so the alert shows what made the calls.
  lastHour: { feature: string; calls: number; costUsd: number; items: number; maxCallsOneItem: number }[];
};

// Set 2026-11-03 above the records so far: worst hour $17.59, worst day
// $30.37, busiest month $128 (October).
export const DEFAULT_LIMITS: GuardLimits = { hour: 25, day: 60, month: 300 };

const LIMITS_KEY = "ai.guard.limits";
const PAUSE_KEY = "ai.guard.pause";
// Resume adds one more limit's worth to the window that tripped, for that
// window only (keyed, so it lapses when the hour/day/month rolls over).
const EXTRA_KEY = "ai.guard.extra";

const REFRESH_MS = 10_000;
const REPEAT_WINDOW_MS = 10 * 60_000;
// The 9th identical request in the window is refused. Not lower: several
// identical units scanned in a row, or Regenerate tapped a few times, can
// legitimately send the same prompt; a real loop passes 8 in seconds.
const REPEAT_MAX = 8;

const WINDOW_WORDS: Record<GuardWindow, string> = { hour: "hour", day: "day", month: "month" };

async function readJson<T>(key: string): Promise<T | null> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function getGuardLimits(): Promise<GuardLimits> {
  const saved = await readJson<Partial<GuardLimits>>(LIMITS_KEY);
  return { ...DEFAULT_LIMITS, ...saved };
}

export async function setGuardLimits(limits: GuardLimits): Promise<void> {
  const value = JSON.stringify(limits);
  await prisma.appSetting.upsert({ where: { key: LIMITS_KEY }, create: { key: LIMITS_KEY, value }, update: { value } });
  cached = null;
}

// Spend so far in the current Chicago hour, day and month. A row with no
// cost estimate (a model missing from aiUsage.ts's price table) is counted
// at Opus rates so the guard never under-counts it.
async function spendNow(): Promise<{ spent: Record<GuardWindow, number>; keys: WindowKeys }> {
  const [row] = await prisma.$queryRaw<
    { hour: number; day: number; month: number; hourKey: string; dayKey: string; monthKey: string }[]
  >`
    with n as (select now() at time zone 'America/Chicago' as t),
    u as (
      select ("createdAt" at time zone 'UTC') at time zone 'America/Chicago' as t,
        coalesce("estimatedCostUsd", ("inputTokens" * 4 + "outputTokens" * 20) / 1000000.0 + "webSearches" * 0.01) as c
      from "AiUsageLog"
      where "createdAt" >= (now() at time zone 'UTC') - interval '32 days'
    )
    select
      coalesce(sum(u.c) filter (where u.t >= date_trunc('hour', n.t)), 0)::float8 as hour,
      coalesce(sum(u.c) filter (where u.t >= date_trunc('day', n.t)), 0)::float8 as day,
      coalesce(sum(u.c) filter (where u.t >= date_trunc('month', n.t)), 0)::float8 as month,
      to_char(n.t, 'YYYY-MM-DD"T"HH24') as "hourKey",
      to_char(n.t, 'YYYY-MM-DD') as "dayKey",
      to_char(n.t, 'YYYY-MM') as "monthKey"
    from n left join u on true
    group by n.t`;
  return {
    spent: { hour: row.hour, day: row.day, month: row.month },
    keys: { hour: row.hourKey, day: row.dayKey, month: row.monthKey },
  };
}

function capFor(w: GuardWindow, limits: GuardLimits, extra: Extra, keys: WindowKeys): number {
  const e = extra[w];
  return limits[w] + (e && e.key === keys[w] ? e.usd : 0);
}

export async function getGuardStatus() {
  const [{ spent, keys }, limits, extra, pause] = await Promise.all([
    spendNow(),
    getGuardLimits(),
    readJson<Extra>(EXTRA_KEY),
    readJson<GuardPause>(PAUSE_KEY),
  ]);
  const caps = {
    hour: capFor("hour", limits, extra ?? {}, keys),
    day: capFor("day", limits, extra ?? {}, keys),
    month: capFor("month", limits, extra ?? {}, keys),
  };
  return { spent, keys, limits, caps, pause };
}

export async function lastHourBreakdown(): Promise<GuardPause["lastHour"]> {
  const rows = await prisma.$queryRaw<{ feature: string; calls: number; cost: number; items: number; maxOne: number }[]>`
    with r as (
      select feature, "itemId", coalesce("estimatedCostUsd", 0)::float8 as c
      from "AiUsageLog" where "createdAt" >= (now() at time zone 'UTC') - interval '60 minutes'
    ),
    per_item as (
      select feature, max(n)::int as "maxOne" from (
        select feature, "itemId", count(*) as n from r where "itemId" is not null group by 1, 2
      ) x group by 1
    )
    select r.feature, count(*)::int as calls, round(sum(r.c)::numeric, 2)::float8 as cost,
      count(distinct r."itemId")::int as items, coalesce(max(p."maxOne"), 0)::int as "maxOne"
    from r left join per_item p on p.feature = r.feature
    group by r.feature order by cost desc`;
  return rows.map((r) => ({ feature: r.feature, calls: r.calls, costUsd: r.cost, items: r.items, maxCallsOneItem: r.maxOne }));
}

async function alertOwner(pause: GuardPause): Promise<void> {
  if (!mailerConfigured()) return;
  const owners = await prisma.user.findMany({ where: { role: "owner", email: { not: null } }, select: { email: true } });
  // No owner email on file: send it to the app's own Gmail so it still lands somewhere he reads.
  const to = owners.map((o) => o.email!).filter(Boolean);
  if (to.length === 0 && process.env.EPIC_STEALS_GMAIL_USER) to.push(process.env.EPIC_STEALS_GMAIL_USER);
  if (to.length === 0) return;

  const lines = pause.lastHour.map(
    (f) =>
      `${f.feature}: ${f.calls} calls, $${f.costUsd.toFixed(2)}` +
      (f.items > 0 ? `, ${f.items} items${f.maxCallsOneItem > 3 ? ` (one item called ${f.maxCallsOneItem} times: looks like a loop)` : ""}` : "")
  );
  const head = `The eBay Tool spent $${pause.spentUsd.toFixed(2)} on AI this ${WINDOW_WORDS[pause.window]}, over the $${pause.limitUsd.toFixed(2)} limit. All AI is paused until you resume it.`;
  const help =
    "If this matches what you were doing (a big scanning or listing session), resume it in Settings > AI spending. " +
    "If it doesn't (calls while nobody was working, one item called over and over), leave it paused and get it looked at.";
  const text = `${head}\n\nLast 60 minutes:\n${lines.join("\n") || "(nothing logged)"}\n\n${help}`;
  const html =
    `<p>${head}</p><p><strong>Last 60 minutes:</strong></p><ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("") || "<li>(nothing logged)</li>"}</ul><p>${help}</p>`;
  await sendEmail({ to: to.join(", "), subject: `AI paused: eBay Tool hit its $${pause.limitUsd} ${WINDOW_WORDS[pause.window]} limit`, html, text });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function trip(window: GuardWindow, limitUsd: number, spentUsd: number, windowKey: string): Promise<GuardPause> {
  const pause: GuardPause = { window, windowKey, limitUsd, spentUsd, at: new Date().toISOString(), lastHour: await lastHourBreakdown() };
  try {
    // create, not upsert: when several servers trip at once, only the first
    // one writes the pause and sends the email.
    await prisma.appSetting.create({ data: { key: PAUSE_KEY, value: JSON.stringify(pause) } });
  } catch {
    return (await readJson<GuardPause>(PAUSE_KEY)) ?? pause;
  }
  try {
    await alertOwner(pause);
  } catch (e) {
    console.error("[aiSpendGuard] couldn't email the pause alert", e);
  }
  return pause;
}

// Owner tapped Resume: clear the pause and allow one more limit's worth in
// every window that's currently over, so it doesn't trip again right away.
export async function resumeGuard(): Promise<void> {
  const status = await getGuardStatus();
  const extra = (await readJson<Extra>(EXTRA_KEY)) ?? {};
  for (const w of ["hour", "day", "month"] as const) {
    if (status.spent[w] >= status.caps[w]) {
      const prior = extra[w]?.key === status.keys[w] ? extra[w]!.usd : 0;
      extra[w] = { key: status.keys[w], usd: prior + status.limits[w] };
    }
  }
  const value = JSON.stringify(extra);
  await prisma.appSetting.upsert({ where: { key: EXTRA_KEY }, create: { key: EXTRA_KEY, value }, update: { value } });
  await prisma.appSetting.deleteMany({ where: { key: PAUSE_KEY } });
  cached = null;
}

// ---- the per-request check ----

let cached: { at: number; blocked: string | null } | null = null;
let inflight: Promise<string | null> | null = null;

function pausedMessage(p: GuardPause): string {
  return `AI is paused: the $${p.limitUsd} per ${WINDOW_WORDS[p.window]} spending limit was hit. The owner can check it and resume in Settings > AI spending.`;
}

async function evaluate(): Promise<string | null> {
  const status = await getGuardStatus();
  if (status.pause) return pausedMessage(status.pause);
  for (const w of ["hour", "day", "month"] as const) {
    if (status.spent[w] >= status.caps[w]) {
      return pausedMessage(await trip(w, status.caps[w], status.spent[w], status.keys[w]));
    }
  }
  return null;
}

// Reason the call is refused, or null to let it through. Cached for a few
// seconds per server so a burst of calls costs one database read. If the
// check itself fails, the call is refused (fail closed): a database outage
// breaks the AI features anyway, and a query broken by a schema change must
// not silently switch the guard off. Retried after REFRESH_MS.
async function spendBlockReason(): Promise<string | null> {
  if (cached && Date.now() - cached.at < REFRESH_MS) return cached.blocked;
  inflight ??= evaluate()
    .then((blocked) => {
      cached = { at: Date.now(), blocked };
      return blocked;
    })
    .catch((e) => {
      console.error("[aiSpendGuard] spend check failed, refusing the call", e);
      const blocked = "AI is paused: the spending check couldn't run. Try again in a minute; if it keeps happening, the guard needs a look.";
      cached = { at: Date.now(), blocked };
      return blocked;
    })
    .finally(() => {
      inflight = null;
    });
  return await inflight;
}

const recent = new Map<string, number[]>();

function repeatBlockReason(body: string): string | null {
  const now = Date.now();
  const hash = createHash("sha256").update(body).digest("hex");
  const times = (recent.get(hash) ?? []).filter((t) => now - t < REPEAT_WINDOW_MS);
  if (times.length >= REPEAT_MAX) {
    recent.set(hash, times);
    return `AI call refused: the exact same request was already sent ${times.length} times in the last 10 minutes, which looks like a loop.`;
  }
  times.push(now);
  recent.set(hash, times);
  if (recent.size > 2000) {
    for (const [k, v] of recent) if (v.every((t) => now - t >= REPEAT_WINDOW_MS)) recent.delete(k);
  }
  return null;
}

function refused(message: string): Response {
  // 400 so the SDK doesn't retry it; shaped like an Anthropic error so the
  // message reaches whatever shows the caller's error.
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

// The fetch the shared Anthropic client uses. Only message requests cost
// money; everything else (token counting, model lists) passes straight through.
export const guardedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "POST" && url.pathname === "/v1/messages") {
    const spend = await spendBlockReason();
    if (spend) {
      console.error(`[aiSpendGuard] ${spend}`);
      return refused(spend);
    }
    if (typeof init?.body === "string") {
      const loop = repeatBlockReason(init.body);
      if (loop) {
        console.error(`[aiSpendGuard] ${loop}`);
        return refused(loop);
      }
    }
  }
  return await fetch(input, init);
};
