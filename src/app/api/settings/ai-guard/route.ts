import { ownerOnly } from "@/lib/auth";
import { logActivity } from "@/lib/activityLog";
import { getGuardLimits, getGuardStatus, resumeGuard, setGuardLimits, type GuardLimits } from "@/lib/aiSpendGuard";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const status = await getGuardStatus();
  return NextResponse.json({ spent: status.spent, limits: status.limits, caps: status.caps, pause: status.pause });
}

// { limits: { hour, day, month } } saves new limits; { resume: true } lifts a pause.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) ?? {};

  if (body.resume === true) {
    const before = (await getGuardStatus()).pause;
    await resumeGuard();
    await logActivity({ request }, { action: "setting", summary: "Resumed AI after a spending-limit pause", targetType: "setting", targetId: "ai-guard", before, after: null });
  } else if (body.limits && typeof body.limits === "object") {
    const next: Partial<GuardLimits> = {};
    for (const w of ["hour", "day", "month"] as const) {
      const v = Number(body.limits[w]);
      if (!Number.isFinite(v) || v < 1 || v > 10000) {
        return NextResponse.json({ error: "Each limit must be a dollar amount between 1 and 10,000." }, { status: 400 });
      }
      next[w] = Math.round(v * 100) / 100;
    }
    const before = await getGuardLimits();
    await setGuardLimits(next as GuardLimits);
    await logActivity({ request }, { action: "setting", summary: `AI spending limits: ${JSON.stringify(before)} -> ${JSON.stringify(next)}`, targetType: "setting", targetId: "ai-guard", before, after: next });
  } else {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const status = await getGuardStatus();
  return NextResponse.json({ spent: status.spent, limits: status.limits, caps: status.caps, pause: status.pause });
}
