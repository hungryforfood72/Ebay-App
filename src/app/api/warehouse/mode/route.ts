import { ownerOnly } from "@/lib/auth";
import { isWarehouseMode, setWarehouseMode } from "@/lib/warehouse/settings";
import { NextRequest, NextResponse } from "next/server";

// Whether warehouse mode is on. Any signed-in user can read it (the scan
// page needs to know which flow to show); only the owner can flip it.
export async function GET() {
  return NextResponse.json({ on: await isWarehouseMode() });
}

export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  if (typeof body.on !== "boolean") return NextResponse.json({ error: "Send { on: true | false }." }, { status: 400 });
  await setWarehouseMode(body.on);
  return NextResponse.json({ on: body.on });
}
