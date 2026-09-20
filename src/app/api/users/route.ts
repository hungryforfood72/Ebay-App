import { AuthError, hashPassword, requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// Also gated at the proxy.ts layer (/api/users is in its ownerOnlyPrefixes)
// — requireOwner here is defense in depth, not the only check, per the
// Next.js docs' own warning not to rely on proxy alone.
export async function GET(request: Request) {
  try {
    requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const users = await prisma.user.findMany({
    select: { id: true, username: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ users });
}

export async function POST(request: Request) {
  try {
    requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = await request.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  const role = body.role === "owner" ? "owner" : "employee";

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json({ error: `"${username}" is already taken.` }, { status: 400 });
  }

  const { hash, salt } = await hashPassword(password);
  const user = await prisma.user.create({
    data: { username, passwordHash: hash, passwordSalt: salt, role },
    select: { id: true, username: true, role: true, createdAt: true },
  });
  return NextResponse.json(user, { status: 201 });
}
