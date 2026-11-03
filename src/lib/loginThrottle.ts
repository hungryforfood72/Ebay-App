import { prisma } from "@/lib/prisma";

// Password sign-in brute-force guard. Counts the "auth.login_failed" rows the
// activity log already writes (indexed by action + time), so it needs no
// table of its own. A username, or an IP, with too many misses in the window
// is refused until the window passes, even with the right password.
const WINDOW_MINUTES = 15;
const MAX_FAILURES_PER_USERNAME = 10;
const MAX_FAILURES_PER_IP = 25;

export const LOCKED_MESSAGE = `Too many sign-in tries. Wait ${WINDOW_MINUTES} minutes and try again.`;

export async function loginLocked(username: string, ip: string | null): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);
  const [byUsername, byIp] = await Promise.all([
    prisma.activityLog.count({ where: { action: "auth.login_failed", at: { gte: since }, targetId: username } }),
    ip ? prisma.activityLog.count({ where: { action: "auth.login_failed", at: { gte: since }, ip } }) : Promise.resolve(0),
  ]);
  return byUsername >= MAX_FAILURES_PER_USERNAME || byIp >= MAX_FAILURES_PER_IP;
}
