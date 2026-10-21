import { requireUser } from "@/lib/auth";
import { WarehouseError } from "@/lib/warehouse/bins";
import { undoReturn } from "@/lib/warehouse/consignmentSort";
import { errorResponse } from "@/lib/warehouse/stations";
import { undoSortLog } from "@/lib/warehouse/sortStation";
import { NextRequest, NextResponse } from "next/server";

// Undo a sort station log: { kind: "good" | "dud" | "damaged" | "return", id }
// (the id the log call returned; damaged covers expired too, return is a
// consignment unit set aside for the supplier). Only whoever logged it, or
// the owner.
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    if (!["good", "dud", "damaged", "return"].includes(body.kind) || typeof body.id !== "string") {
      throw new WarehouseError('Send { kind: "good" | "dud" | "damaged" | "return", id }.');
    }
    if (body.kind === "return") await undoReturn({ id: body.id, user });
    else await undoSortLog({ kind: body.kind, id: body.id, user });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
