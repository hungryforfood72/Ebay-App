import { logActivity } from "@/lib/activityLog";
import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { retailCheckList, setLineRetail } from "@/lib/retailCheck";
import { NextRequest, NextResponse } from "next/server";

// Review's "Retail to check" list (owner only: it shows store prices and
// changes what the store charges).
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  return NextResponse.json({ rows: await retailCheckList() });
}

// { manifestId, upc, unitRetail } (or { itemId, unitRetail }) sets the real retail for one unit;
// unitRetail null (or left out) just marks it checked as is.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  // The Review card sends its item instead (a single, not a bundle).
  if (typeof body.itemId === "string") {
    const item = await prisma.item.findUnique({ where: { id: body.itemId }, select: { manifestId: true, upc: true } });
    body.manifestId = item?.manifestId;
    body.upc = item?.upc;
  }
  if (typeof body.manifestId !== "string" || typeof body.upc !== "string") {
    return NextResponse.json({ error: "This item has no manifest line to fix." }, { status: 400 });
  }
  const unitRetail = body.unitRetail == null || body.unitRetail === "" ? null : Math.round(Number(body.unitRetail) * 100) / 100;
  if (unitRetail != null && (!Number.isFinite(unitRetail) || unitRetail <= 0)) {
    return NextResponse.json({ error: "Enter a retail price above $0." }, { status: 400 });
  }
  const before = await prisma.manifestLine.findFirst({ where: { manifestId: body.manifestId, upc: body.upc }, select: { retailPrice: true, description: true } });
  const updated = await setLineRetail(body.manifestId, body.upc, unitRetail);
  if (updated > 0) {
    await logActivity({ request }, {
      action: "retail",
      summary:
        unitRetail == null
          ? `Marked retail $${before?.retailPrice} as right on ${before?.description ?? body.upc}`
          : `Retail $${before?.retailPrice} -> $${unitRetail} on ${before?.description ?? body.upc}`,
      targetType: "manifestLine",
      targetId: `${body.manifestId}:${body.upc}`,
      before: { retailPrice: before?.retailPrice ?? null },
      after: { retailPrice: unitRetail ?? before?.retailPrice ?? null },
    });
  }
  if (updated === 0) return NextResponse.json({ error: "That item isn't on the manifest." }, { status: 404 });
  return NextResponse.json({ updated });
}
