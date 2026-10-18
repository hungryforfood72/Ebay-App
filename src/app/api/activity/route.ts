import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";

const PAGE = 100;

// The activity log, newest first (owner only). ?user= ?q= (in the summary
// or path) ?important=1 (leave out the raw "request" rows) ?before= (an
// ISO time, for the next page).
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const p = request.nextUrl.searchParams;
  const where: Prisma.ActivityLogWhereInput = {};
  const user = p.get("user");
  if (user) where.username = user;
  if (p.get("important") === "1") where.action = { not: "request" };
  const q = p.get("q")?.trim();
  if (q) where.OR = [{ summary: { contains: q, mode: "insensitive" } }, { path: { contains: q, mode: "insensitive" } }, { targetId: q }];
  const before = p.get("before");
  if (before && !Number.isNaN(Date.parse(before))) where.at = { lt: new Date(before) };
  const [rows, users] = await Promise.all([
    prisma.activityLog.findMany({ where, orderBy: { at: "desc" }, take: PAGE }),
    prisma.user.findMany({ select: { username: true }, orderBy: { username: "asc" } }),
  ]);
  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, at: r.at.toISOString() })),
    users: users.map((u) => u.username),
    more: rows.length === PAGE,
  });
}
