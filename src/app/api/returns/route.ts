import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { itemTitle, PENDING_DECISION, recordReturn, type StoredReturnReport } from "@/lib/warehouse/returns";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// GET — today's returns (Chicago day), newest first, for the returns page.
// The agent's money reasoning only goes to the owner.
export async function GET(request: NextRequest) {
  const isOwner = getRequestUser(request)?.role === "owner";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  // Start of today in Chicago: midnight there is 05:00 or 06:00 UTC, so
  // take the earlier one; a return from 11pm-midnight the night before at
  // most shows up for an extra hour.
  const since = new Date(`${today}T05:00:00Z`);
  const rows = await prisma.itemReturn.findMany({
    // Pending = the agent was asked but nobody finished; not a return yet.
    where: { createdAt: { gte: since }, decision: { not: PENDING_DECISION } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { item: { select: { sku: true, finalTitle: true, aiTitle: true, upc: true } } },
  });
  const newIds = rows.map((r) => r.newItemId).filter((id): id is string => Boolean(id));
  const newItems = new Map(
    (await prisma.item.findMany({ where: { id: { in: newIds } }, select: { id: true, sku: true } })).map((i) => [i.id, i.sku])
  );
  return NextResponse.json(
    rows.map((r) => {
      const report = (r.report ?? null) as StoredReturnReport | null;
      return {
        id: r.id,
        createdAt: r.createdAt,
        sku: r.item.sku,
        title: itemTitle(r.item),
        units: r.units,
        channel: r.channel,
        orderId: r.orderId,
        sameCondition: r.sameCondition,
        decision: r.decision,
        reason: r.reason,
        overridden: report?.overridden ?? false,
        suggested: report?.advice?.decision ?? null,
        newItemSku: r.newItemId ? (newItems.get(r.newItemId) ?? null) : null,
        recordedBy: r.recordedBy,
        ...(isOwner ? { ownerReason: report?.advice?.ownerReason ?? null } : {}),
      };
    })
  );
}

// POST { itemId, channel?, orderId?, units, sameCondition, decision?,
// report?, plan?, adviceId?, stationId? } — records a return and does what it says
// (src/lib/warehouse/returns.ts recordReturn). Same condition: the server
// decides add_back or relist_same from the listing, and relist_same needs
// stationId for the new labels. Not the same: decision is the agent's call
// or the employee's override; relist_new / shopify_only are then finished
// on the scan page at `next`.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  try {
    const result = await recordReturn({
      itemId: String(body.itemId ?? ""),
      channel: typeof body.channel === "string" ? body.channel : null,
      orderId: typeof body.orderId === "string" ? body.orderId : null,
      units: Number(body.units),
      sameCondition: body.sameCondition === true,
      decision: typeof body.decision === "string" ? body.decision : null,
      report: body.report,
      // The employee's own split of the units, when they changed the agent's.
      plan: body.plan,
      adviceId: typeof body.adviceId === "string" ? body.adviceId : null,
      stationId: typeof body.stationId === "string" ? body.stationId : null,
      by: getRequestUser(request)?.username ?? null,
    });
    const next =
      result.decision === "relist_new" || result.decision === "shopify_only" ? `/scan?return=${result.returnId}` : null;
    return NextResponse.json({ ...result, next }, { status: 201 });
  } catch (e) {
    if (e instanceof WarehouseError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
