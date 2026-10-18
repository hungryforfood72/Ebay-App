import { logActivity } from "@/lib/activityLog";
import { getExpirationBufferDays, setExpirationBufferDays } from "@/lib/expireListings";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const bufferDays = await getExpirationBufferDays();
  return NextResponse.json({ bufferDays });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const bufferDays = Number(body.bufferDays);
  if (!Number.isFinite(bufferDays) || bufferDays < 0 || bufferDays > 90) {
    return NextResponse.json({ error: "Buffer days must be a number between 0 and 90." }, { status: 400 });
  }
  const before = await getExpirationBufferDays();
  await setExpirationBufferDays(bufferDays);
  await logActivity({ request }, { action: "setting", summary: `Expiration buffer (days): ${JSON.stringify(before)} -> ${JSON.stringify(bufferDays)}`, targetType: "setting", targetId: "expiration-buffer", before, after: bufferDays });
  return NextResponse.json({ bufferDays });
}
