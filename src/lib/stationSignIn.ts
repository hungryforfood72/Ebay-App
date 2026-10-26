import { randomBytes, randomInt, timingSafeEqual } from "crypto";
import { hashPassword, verifyPassword } from "./auth";
import { prisma } from "./prisma";
import { PIN_PATTERN, SIGN_IN_CODE_ALPHABET, SIGN_IN_CODE_LENGTH, SIGN_IN_CODE_PREFIX } from "./stationSignInCode";

// Scan-to-sign-in at a station PC (Cristian, 2026-10-26): people switch
// stations a lot, and typing a username and password on every PC ate time.
// Every employee has their own handheld, already signed in as them, so:
//   1. "Log out" on the station PC shows /station-pc: a QR code for that
//      station (StationSignIn, single use, SIGN_IN_CODE_MINUTES).
//   2. They scan it with their handheld from any scan field and type their
//      PIN on the handheld.
//   3. The PC's next check (every 2s) finds the code claimed and signs in as
//      them, for STATION_SESSION_MS, and the handheld switches to printing
//      at that station.
// A PC can only show codes if it holds that station's station_device
// cookie (Station.signInKey), set when someone opens the station page
// there signed in. So no one outside can make codes for a station, and
// the PC is the only thing that can turn a claimed code into a session.

export const STATION_DEVICE_COOKIE = "station_device";
const STATION_DEVICE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const SIGN_IN_CODE_MINUTES = 10;
// A shift, not the 30 days a password sign-in lasts: a station nobody
// logged out of is back on the sign-in screen the next morning.
export const STATION_SESSION_MS = 14 * 60 * 60 * 1000;

export const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MINUTES = 15;

export function stationDeviceCookieValue(stationId: string, key: string): string {
  return `${stationId}.${key}`;
}

export const STATION_DEVICE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: STATION_DEVICE_MAX_AGE_SECONDS,
  path: "/",
};

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}

// The station this PC is set up as, or null (no cookie, a stale key, or
// the station was deleted).
export async function stationForDevice(request: Request): Promise<{ id: string; name: string } | null> {
  return stationForDeviceValue(readCookie(request, STATION_DEVICE_COOKIE));
}

// Same check for a "<stationId>.<key>" value from anywhere (the cookie, or
// the installer's shortcut URL).
export async function stationForDeviceValue(value: string | null): Promise<{ id: string; name: string } | null> {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const stationId = value.slice(0, dot);
  const key = value.slice(dot + 1);
  const station = await prisma.station.findUnique({ where: { id: stationId }, select: { id: true, name: true, signInKey: true } });
  if (!station?.signInKey) return null;
  const a = Buffer.from(key);
  const b = Buffer.from(station.signInKey);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { id: station.id, name: station.name };
}

// The station's key, made the first time it's asked for.
export async function ensureSignInKey(stationId: string): Promise<string | null> {
  const station = await prisma.station.findUnique({ where: { id: stationId }, select: { signInKey: true } });
  if (!station) return null;
  if (station.signInKey) return station.signInKey;
  const key = randomBytes(24).toString("base64url");
  // Only if still empty, so two tabs opening at once agree on one key.
  await prisma.station.updateMany({ where: { id: stationId, signInKey: null }, data: { signInKey: key } });
  const saved = await prisma.station.findUnique({ where: { id: stationId }, select: { signInKey: true } });
  return saved?.signInKey ?? null;
}

function randomCode(): string {
  let code = SIGN_IN_CODE_PREFIX;
  for (let i = 0; i < SIGN_IN_CODE_LENGTH; i++) code += SIGN_IN_CODE_ALPHABET[randomInt(SIGN_IN_CODE_ALPHABET.length)];
  return code;
}

// A fresh code for the station's sign-in screen. Its old codes go: a
// screen only ever shows its newest one.
export async function newSignInCode(stationId: string): Promise<{ code: string; expiresAt: Date }> {
  await prisma.stationSignIn.deleteMany({
    where: { OR: [{ stationId }, { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }] },
  });
  const expiresAt = new Date(Date.now() + SIGN_IN_CODE_MINUTES * 60 * 1000);
  for (let attempt = 0; ; attempt++) {
    try {
      const row = await prisma.stationSignIn.create({ data: { code: randomCode(), stationId, expiresAt }, select: { code: true } });
      return { code: row.code, expiresAt };
    } catch (e) {
      // A code collision (unique), astronomically rare: just draw again.
      if (attempt >= 3) throw e;
    }
  }
}

export type PinCheck = { ok: true } | { ok: false; error: string; status: number };

function lockedMessage(until: Date): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return `Too many wrong PINs. Try again in ${minutes} min, or ask the owner to reset your PIN.`;
}

// Checks someone's PIN, counting wrong tries: PIN_MAX_FAILURES in a row
// locks it for PIN_LOCK_MINUTES.
export async function checkPin(userId: string, pin: string): Promise<PinCheck> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pinHash: true, pinSalt: true, pinFailures: true, pinLockedUntil: true },
  });
  if (!user?.pinHash || !user.pinSalt) return { ok: false, error: "Set up your PIN first.", status: 400 };
  if (user.pinLockedUntil && user.pinLockedUntil.getTime() > Date.now()) {
    return { ok: false, error: lockedMessage(user.pinLockedUntil), status: 429 };
  }
  if (PIN_PATTERN.test(pin) && (await verifyPassword(pin, user.pinHash, user.pinSalt))) {
    if (user.pinFailures > 0 || user.pinLockedUntil) {
      await prisma.user.update({ where: { id: userId }, data: { pinFailures: 0, pinLockedUntil: null } });
    }
    return { ok: true };
  }
  const failures = user.pinFailures + 1;
  if (failures >= PIN_MAX_FAILURES) {
    const until = new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000);
    await prisma.user.update({ where: { id: userId }, data: { pinFailures: 0, pinLockedUntil: until } });
    return { ok: false, error: lockedMessage(until), status: 429 };
  }
  await prisma.user.update({ where: { id: userId }, data: { pinFailures: failures } });
  const left = PIN_MAX_FAILURES - failures;
  return { ok: false, error: `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`, status: 401 };
}

export async function setPin(userId: string, pin: string): Promise<void> {
  const { hash, salt } = await hashPassword(pin);
  await prisma.user.update({
    where: { id: userId },
    data: { pinHash: hash, pinSalt: salt, pinFailures: 0, pinLockedUntil: null },
  });
}
