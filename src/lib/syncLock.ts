import { prisma } from "./prisma";

// Longer than any one run can take (the cron routes cap out at 300s), so a
// live run never loses its lock, while a run that died lets go on its own.
const LOCK_TTL_MS = 6 * 60 * 1000;
// A burst of sales can keep asking for reruns; past this many the next
// cron picks up whatever is left.
const MAX_RERUNS = 3;

export type LockedRun<T> = { ran: true; results: T[] } | { ran: false };

// Runs `run` under the named SyncLock (see the model). If another run holds
// the lock, this asks it to go again once it's done and returns
// { ran: false } right away, so whatever triggered this call still gets
// handled, just by the run already in progress. `mode` is passed through
// to `run`; a rerun asked for as "full" stays "full" even if a "quick" ask
// came in after it.
export async function withSyncLock<T>(
  name: string,
  mode: string,
  run: (mode: string) => Promise<T>
): Promise<LockedRun<T>> {
  if (!(await tryAcquire(name))) {
    if (await requestRerun(name, mode)) return { ran: false };
    // The holder let go between the two checks: take it.
    if (!(await tryAcquire(name))) {
      await requestRerun(name, mode);
      return { ran: false };
    }
  }

  const results: T[] = [];
  let currentMode = mode;
  let released = false;
  try {
    for (let i = 0; ; i++) {
      results.push(await run(currentMode));
      // Let go only if nobody asked for a rerun, in one statement, so a
      // request landing just as this run finishes can't fall in the gap.
      if (await releaseIfIdle(name)) {
        released = true;
        break;
      }
      const rerun = await takeRerun(name);
      if (!rerun || i >= MAX_RERUNS) break;
      currentMode = rerun;
    }
  } finally {
    if (!released) await forceRelease(name);
  }
  return { ran: true, results };
}

async function tryAcquire(name: string): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + LOCK_TTL_MS);
  const rows = await prisma.$executeRaw`
    INSERT INTO "SyncLock" ("name", "lockedUntil", "rerunRequested")
    VALUES (${name}, ${until}, false)
    ON CONFLICT ("name") DO UPDATE
      SET "lockedUntil" = EXCLUDED."lockedUntil", "rerunRequested" = false, "rerunMode" = NULL
      WHERE "SyncLock"."lockedUntil" < ${now}`;
  return rows > 0;
}

// True if a run is holding the lock and will see the request.
async function requestRerun(name: string, mode: string): Promise<boolean> {
  const rows = await prisma.$executeRaw`
    UPDATE "SyncLock"
      SET "rerunRequested" = true,
          "rerunMode" = CASE WHEN "rerunMode" = 'full' THEN 'full' ELSE ${mode} END
      WHERE "name" = ${name} AND "lockedUntil" >= ${new Date()}`;
  return rows > 0;
}

// Clears a pending rerun request and returns its mode, also pushing the
// lock's expiry out again for the next pass.
async function takeRerun(name: string): Promise<string | null> {
  const until = new Date(Date.now() + LOCK_TTL_MS);
  const rows = await prisma.$queryRaw<{ mode: string | null }[]>`
    UPDATE "SyncLock" AS l
      SET "rerunRequested" = false, "rerunMode" = NULL, "lockedUntil" = ${until}
      FROM (SELECT "rerunMode" FROM "SyncLock" WHERE "name" = ${name}) AS prev
      WHERE l."name" = ${name} AND l."rerunRequested" = true
      RETURNING prev."rerunMode" AS mode`;
  return rows.length > 0 ? (rows[0].mode ?? "quick") : null;
}

async function releaseIfIdle(name: string): Promise<boolean> {
  const rows = await prisma.$executeRaw`
    UPDATE "SyncLock" SET "lockedUntil" = ${new Date(0)}
      WHERE "name" = ${name} AND "rerunRequested" = false`;
  return rows > 0;
}

// After an error, or once MAX_RERUNS is used up: whatever is still pending
// is picked up by the next cron at the latest.
async function forceRelease(name: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SyncLock" SET "lockedUntil" = ${new Date(0)}, "rerunRequested" = false, "rerunMode" = NULL
      WHERE "name" = ${name}`;
}
