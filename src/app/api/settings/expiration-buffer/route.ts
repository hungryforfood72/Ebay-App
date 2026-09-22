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
  await setExpirationBufferDays(bufferDays);
  return NextResponse.json({ bufferDays });
}
