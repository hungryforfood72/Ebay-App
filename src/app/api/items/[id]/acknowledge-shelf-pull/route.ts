import { AuthError, getRequestUser, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Either role can acknowledge — whoever physically pulled the item off the
// shelf, owner or employee, same as walk-up sales and stock adjustments.
// recordedBy comes from the session, not the request body.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireUser(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  if (item.status !== "expired") {
    return NextResponse.json({ error: "This item isn't marked expired." }, { status: 400 });
  }
  if (item.shelfPullAcknowledgedAt) {
    return NextResponse.json(item);
  }

  const username = getRequestUser(request)?.username ?? null;
  const updated = await prisma.item.update({
    where: { id },
    data: { shelfPullAcknowledgedAt: new Date(), shelfPullAcknowledgedBy: username },
  });
  return NextResponse.json(updated);
}
