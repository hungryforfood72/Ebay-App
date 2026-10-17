import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { adviseReturn } from "@/lib/warehouse/returnAdvisor";
import { adviceInputFor, parseReport, savePendingAdvice } from "@/lib/warehouse/returns";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// POST { itemId, units, report, channel?, orderId?, adviceId? }: the return
// agent's call for a return that isn't in the same brand-new condition
// (src/lib/warehouse/returnAdvisor.ts). Saved as a pending ItemReturn
// (adviceId, sent back to POST /api/returns with what was actually done),
// so the owner's money reasoning is kept whoever asked. Asking again with
// the same adviceId updates it. ownerReason only goes back to the owner.
export async function POST(request: NextRequest) {
  const isOwner = getRequestUser(request)?.role === "owner";
  const body = await request.json().catch(() => ({}));
  const units = Number(body.units);
  if (!Number.isInteger(units) || units < 1) {
    return NextResponse.json({ error: "How many came back has to be a whole number, at least 1." }, { status: 400 });
  }
  const item = typeof body.itemId === "string" ? await prisma.item.findUnique({ where: { id: body.itemId } }) : null;
  if (!item) return NextResponse.json({ error: "That listing doesn't exist anymore." }, { status: 404 });
  const report = parseReport(body.report);
  const advice = await adviseReturn(await adviceInputFor(item, units, report));
  const adviceId = await savePendingAdvice({
    adviceId: typeof body.adviceId === "string" ? body.adviceId : null,
    itemId: item.id,
    channel: typeof body.channel === "string" ? body.channel : null,
    orderId: typeof body.orderId === "string" ? body.orderId : null,
    units,
    report,
    advice,
    by: getRequestUser(request)?.username ?? null,
  });
  return NextResponse.json({ ...(isOwner ? advice : { ...advice, ownerReason: null }), adviceId });
}
