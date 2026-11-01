import { logActivity } from "./activityLog";
import { AUTH_COOKIE_NAME, deleteSession } from "./auth";
import { prisma } from "./prisma";
import { readCookie } from "./stationSignIn";

// Auto sign-out at a station PC (Cristian, 2026-11-01): nobody did
// anything there for an hour, so the PC goes back to its sign-in screen and
// stops calling the app. "Did anything" is the latest of:
//   - the station page itself: a mouse move, a key, the scale moving, a
//     label it printed (it sends how long ago, pageIdleMs)
//   - a label queued for this station (from anyone's handheld)
//   - anything that person changed in the app, from any device (their
//     handheld's scans and saves land in the Activity Log)
//   - when they signed in
// The page only asks once its own idle time passes the hour, so this costs
// nothing while someone's at the PC.
//
// Only a station sign-in (Session.stationId) gets signed out. Anyone else
// with a station page open (the owner on his own PC) keeps their sign-in:
// the page just goes to sleep until someone touches it ("idle").
export const STATION_IDLE_MS = 60 * 60_000;

export type IdleCheck = { state: "active"; activeAt: number } | { state: "idle" } | { state: "signed-out" };

export async function checkStationIdle(request: Request, station: { id: string; name: string }, pageIdleMs: number): Promise<IdleCheck> {
  const now = Date.now();
  const token = readCookie(request, AUTH_COOKIE_NAME);
  const session = token
    ? await prisma.session.findUnique({
        where: { token },
        select: { stationId: true, createdAt: true, user: { select: { id: true, username: true, role: true } } },
      })
    : null;
  if (!session) return { state: "active", activeAt: now };
  const since = new Date(now - STATION_IDLE_MS);
  const [job, work] = await Promise.all([
    prisma.printJob.findFirst({ where: { stationId: station.id, createdAt: { gt: since } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.activityLog.findFirst({ where: { username: session.user.username, at: { gt: since } }, orderBy: { at: "desc" }, select: { at: true } }),
  ]);
  const activeAt = Math.max(
    now - Math.max(0, pageIdleMs),
    session.createdAt.getTime(),
    job?.createdAt.getTime() ?? 0,
    work?.at.getTime() ?? 0
  );
  if (now - activeAt < STATION_IDLE_MS) return { state: "active", activeAt };
  if (!session.stationId) return { state: "idle" };

  await deleteSession(token!);
  await logActivity(
    { request, user: session.user },
    {
      action: "auth.logout",
      summary: `${session.user.username} signed out of ${station.name} automatically (nothing done there for an hour)`,
      targetType: "user",
      targetId: session.user.username,
    }
  );
  return { state: "signed-out" };
}
