import { prisma } from "./prisma";

// A publish keeps running on the server when the Review page is refreshed
// mid-publish, but the page forgot it had started, so it looked like
// Publish was never hit (Cristian, 2026-11-02) and a second click could
// start a second publish of the same item. The start time lives on the
// item instead: Review shows "Publishing…" from it, and a second publish
// is refused while one runs.

// Longer than the publish route can run (maxDuration 300s): a claim older
// than this is from a run that died without clearing it.
export const PUBLISH_STALE_MS = 6 * 60 * 1000;

// true = this request owns the publish; false = one is already running.
export async function claimPublish(itemId: string): Promise<boolean> {
  const { count } = await prisma.item.updateMany({
    where: {
      id: itemId,
      OR: [{ publishStartedAt: null }, { publishStartedAt: { lt: new Date(Date.now() - PUBLISH_STALE_MS) } }],
    },
    data: { publishStartedAt: new Date() },
  });
  return count === 1;
}

export async function releasePublish(itemId: string): Promise<void> {
  await prisma.item.update({ where: { id: itemId }, data: { publishStartedAt: null } }).catch(() => {});
}

export const ALREADY_PUBLISHING = "This is already publishing. Give it a minute; the page updates when it's done.";
