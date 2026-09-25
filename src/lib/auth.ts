import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { prisma } from "./prisma";
import type { User } from "@/generated/prisma/client";

const scryptAsync = promisify(scrypt);

export const AUTH_COOKIE_NAME = "session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches the old shared-password cookie's lifetime

const SCRYPT_KEY_LENGTH = 64;

// Real per-user password hashing (replacing the old bare-SHA-256-of-one-
// shared-password scheme) — salted, and scrypt is deliberately
// memory-hard (unlike PBKDF2/SHA-256) to resist GPU brute-forcing if the
// DB ever leaked. Runs fine here since proxy.ts and every auth route run
// on the Node.js runtime (Next.js 16 default — see proxy.ts), not edge,
// so Node's built-in crypto is available without any Web-Crypto
// workarounds.
export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const usedSalt = salt ?? randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, usedSalt, SCRYPT_KEY_LENGTH)) as Buffer;
  return { hash: derived.toString("hex"), salt: usedSalt };
}

export async function verifyPassword(password: string, storedHash: string, storedSalt: string): Promise<boolean> {
  const { hash } = await hashPassword(password, storedSalt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(storedHash, "hex");
  // Constant-time compare — a naive === leaks timing info about how many
  // leading bytes matched, which matters for a hash comparison even
  // though the hash itself isn't the secret (the password is).
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await prisma.session.create({ data: { token, userId, expiresAt } });
  return { token, expiresAt };
}

export async function deleteSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { token } });
}

export type AuthedUser = Pick<User, "id" | "username" | "role">;

// Reads the user proxy.ts already verified for this request, from the
// headers it set (see USER_ID_HEADER etc. in proxy.ts) — no second DB
// lookup needed in the route itself. Safe to trust: proxy.ts always SETS
// these explicitly from its own verified session lookup, overwriting
// anything a client tried to send, so there's nothing here for a request
// to spoof. Returns null only if a route is reachable without going
// through proxy.ts at all (shouldn't happen given the matcher covers
// everything except static assets) — routes that need to be sure call
// requireOwner/requireUser below rather than assuming a non-null result.
export function getRequestUser(request: Request): AuthedUser | null {
  const id = request.headers.get("x-user-id");
  const role = request.headers.get("x-user-role");
  const username = request.headers.get("x-username");
  if (!id || !role || !username) return null;
  return { id, username, role: role as User["role"] };
}

export class AuthError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// Throws (rather than returning null) for routes where "no user" is a
// genuine bug, not an expected case to handle gracefully — keeps the
// route's own code focused on its actual logic instead of repeating the
// same null-check everywhere.
export function requireUser(request: Request): AuthedUser {
  const user = getRequestUser(request);
  if (!user) throw new AuthError("Not signed in.", 401);
  return user;
}

export function requireOwner(request: Request): AuthedUser {
  const user = requireUser(request);
  if (user.role !== "owner") throw new AuthError("Owner access required.", 403);
  return user;
}

// Route-handler shorthand for requireOwner: null when the caller is the
// owner, otherwise the ready-to-return error response.
//   const denied = ownerOnly(request);
//   if (denied) return denied;
export function ownerOnly(request: Request): Response | null {
  try {
    requireOwner(request);
    return null;
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// Looks up a session token against the DB — expired rows are treated as
// absent rather than actively cleaned up here (a lazy-expiry approach;
// stale rows are harmless clutter, not a correctness problem, and don't
// need a cron of their own).
export async function getUserForSessionToken(token: string | undefined | null): Promise<AuthedUser | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: { select: { id: true, username: true, role: true } } },
  });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  return session.user;
}
