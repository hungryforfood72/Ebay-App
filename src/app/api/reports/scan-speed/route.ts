import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeStretches, loadScanEvents, totalsFor, UNKNOWN_PERSON, type ScanKind } from "@/lib/scanSpeed";
import { NextRequest, NextResponse } from "next/server";

const KINDS: ScanKind[] = ["item", "multipack", "bundle", "damaged", "dud"];

// GET ?person=<username|__unknown__>&days=<7|30|90|0=all>&idle=<minutes>
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const days = Math.max(0, Number(params.get("days") ?? 30) || 0);
  const idleMinutes = Math.min(120, Math.max(1, Number(params.get("idle") ?? 10) || 10));
  const since = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

  const [users, hasUnknown] = await Promise.all([
    prisma.user.findMany({
      select: { username: true, role: true },
      orderBy: { username: "asc" },
    }),
    prisma.item.count({ where: { scannedBy: null }, take: 1 }).then((n) => n > 0),
  ]);
  // Employees first: they're who this report is mostly for.
  const people = [...users.filter((u) => u.role === "employee"), ...users.filter((u) => u.role !== "employee")].map(
    (u) => ({ key: u.username, label: u.username })
  );
  if (hasUnknown)
    people.push({
      key: UNKNOWN_PERSON,
      label: "Unknown (before tracking)",
    });

  const requested = params.get("person");
  const person = people.some((p) => p.key === requested) ? requested! : (people[0]?.key ?? UNKNOWN_PERSON);

  const { events, sessionStarts } = await loadScanEvents(person, since);
  const stretches = computeStretches(events, sessionStarts, idleMinutes * 60);
  const allScans = stretches.flatMap((s) => s.scans);

  return NextResponse.json({
    people,
    person,
    days,
    idleMinutes,
    totals: totalsFor(allScans),
    byKind: KINDS.map((kind) => ({
      kind,
      ...totalsFor(allScans.filter((s) => s.kind === kind)),
    })).filter((k) => k.scans > 0),
    stretches: stretches.reverse(),
  });
}
