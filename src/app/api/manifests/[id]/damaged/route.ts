import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Records a tally of damaged/expired units against a manifest — not an
// item, just a count so the reconciliation dashboard can account for why
// something never made it to review.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const upc = String(body.upc ?? "").trim();
  const quantity = Number(body.quantity);

  if (!upc) {
    return NextResponse.json({ error: "UPC is required." }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity < 1) {
    return NextResponse.json({ error: "Quantity must be at least 1." }, { status: 400 });
  }

  const entry = await prisma.manifestDamagedEntry.create({
    data: {
      manifestId: id,
      upc,
      quantity: Math.round(quantity),
      note: body.note ?? null,
      // From the signed-in session (see /reports/scan-speed), not the body.
      recordedBy: getRequestUser(request)?.username ?? null,
    },
  });

  return NextResponse.json(entry, { status: 201 });
}
