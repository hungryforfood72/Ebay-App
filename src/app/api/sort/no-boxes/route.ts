import { logActivity } from "@/lib/activityLog";
import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

// Owner only: { manifestId, on } sorts this load without sort boxes (Good
// just counts units in, no box to scan) or back with them (Cristian,
// 2026-10-24: the medical load). Units already counted in stay as they are.
// -> { sortWithoutBoxes }
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body.manifestId !== "string" || !body.manifestId) throw new WarehouseError("Pick the load first.");
    if (typeof body.on !== "boolean") throw new WarehouseError("Send on: true or false.");
    const found = await prisma.manifest.findUnique({ where: { id: body.manifestId }, select: { id: true, title: true } });
    if (!found) throw new WarehouseError("That load doesn't exist anymore.", 404);
    const m = await prisma.manifest.update({
      where: { id: found.id },
      data: { sortWithoutBoxes: body.on },
      select: { sortWithoutBoxes: true },
    });
    await logActivity(
      { request },
      {
        action: "setting",
        summary: `${found.title}: sort ${body.on ? "without" : "with"} sort boxes`,
        targetType: "manifest",
        targetId: found.id,
        after: { sortWithoutBoxes: body.on },
      }
    );
    return NextResponse.json(m);
  } catch (e) {
    return errorResponse(e);
  }
}
