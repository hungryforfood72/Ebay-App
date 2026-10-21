import { ownerOnly } from "@/lib/auth";
import { loadsWithSorting, sortSpeedForLoad } from "@/lib/scanSpeed";
import { NextRequest, NextResponse } from "next/server";

// GET ?manifestId=&idle=<minutes> -> { loads: [{ id, title, lastAt }],
// load: sortSpeedForLoad(...) | null }. No manifestId = the load sorted
// most recently.
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const idleMinutes = Math.min(120, Math.max(1, Number(params.get("idle") ?? 10) || 10));
  const loads = await loadsWithSorting();
  const requested = params.get("manifestId");
  const manifestId = requested || loads[0]?.id || null;
  const load = manifestId ? await sortSpeedForLoad(manifestId, idleMinutes * 60) : null;
  return NextResponse.json({ loads, load });
}
