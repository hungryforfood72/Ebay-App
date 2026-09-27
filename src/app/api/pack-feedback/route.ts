import { AuthError, requireOwner } from "@/lib/auth";
import { MAX_RECOMMENDED_PACK } from "@/lib/packSize";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// POST { upc, manifestId?, description?, suggestedPackSize?, chosenPackSize, reason }
// Cristian correcting the pack-size agent (see src/lib/packAdvisor.ts).
// Owner only: these become lessons the agent applies to every product.
export async function POST(request: NextRequest) {
  let user;
  try {
    user = requireOwner(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const body = (await request.json().catch(() => null)) as {
    upc?: string;
    manifestId?: string | null;
    description?: string | null;
    suggestedPackSize?: number | null;
    chosenPackSize?: number;
    reason?: string;
  } | null;
  const upc = body?.upc?.trim();
  const reason = body?.reason?.trim();
  const chosenPackSize = Number(body?.chosenPackSize);
  if (!upc) return NextResponse.json({ error: "A UPC is required." }, { status: 400 });
  if (!reason) return NextResponse.json({ error: "Say why, so the agent can learn from it." }, { status: 400 });
  if (!Number.isInteger(chosenPackSize) || chosenPackSize < 1 || chosenPackSize > MAX_RECOMMENDED_PACK) {
    return NextResponse.json({ error: `Pack size must be 1 to ${MAX_RECOMMENDED_PACK}.` }, { status: 400 });
  }

  const line =
    (body?.manifestId
      ? await prisma.manifestLine.findFirst({ where: { manifestId: body.manifestId, upc }, select: { description: true, category: true } })
      : null) ??
    (await prisma.manifestLine.findFirst({ where: { upc }, select: { description: true, category: true } }));

  const suggested = Number(body?.suggestedPackSize);
  const feedback = await prisma.packFeedback.create({
    data: {
      upc,
      description: line?.description ?? body?.description?.trim() ?? `UPC ${upc}`,
      category: line?.category ?? null,
      suggestedPackSize: Number.isInteger(suggested) ? suggested : null,
      chosenPackSize,
      reason: reason.slice(0, 1000),
      createdBy: user.username,
    },
  });

  return NextResponse.json(feedback, { status: 201 });
}
