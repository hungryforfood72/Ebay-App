import { prisma } from "@/lib/prisma";
import { relistPlan } from "@/lib/relist";
import { NextResponse } from "next/server";

// The scan page's guided relist of a split multi-date listing: what to
// prefill for each part and which part is next. See src/lib/relist.ts.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  const plan = item ? relistPlan(item) : null;
  if (!plan) {
    return NextResponse.json({ error: "This listing isn't waiting to be relisted." }, { status: 404 });
  }
  return NextResponse.json(plan);
}
