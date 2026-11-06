import { AuthError, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { productCodeFromScan } from "@/lib/upcMatch";
import { NextRequest, NextResponse } from "next/server";

// Records a tally of units that physically arrived in good condition but
// won't be listed on eBay at all (dead licensed/seasonal merch, no
// realistic resale value, etc.) — not an item, just a count so the
// reconciliation dashboard can account for why something never made it to
// review, same role ManifestDamagedEntry plays for actually-damaged units.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let username: string;
  try {
    username = requireUser(request).username;
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) ?? {};
  if (!(await prisma.manifest.findUnique({ where: { id }, select: { id: true } }))) {
    return NextResponse.json({ error: "That manifest doesn't exist." }, { status: 404 });
  }

  // A GS1 box code or Digital Link scan is stored as the UPC inside it.
  const upc = productCodeFromScan(String(body.upc ?? ""));
  const quantity = Number(body.quantity);

  if (!upc) {
    return NextResponse.json({ error: "UPC is required." }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity < 1) {
    return NextResponse.json({ error: "Quantity must be at least 1." }, { status: 400 });
  }

  const entry = await prisma.manifestDudEntry.create({
    data: {
      manifestId: id,
      upc,
      quantity: Math.round(quantity),
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
      // From the signed-in session (see /reports/scan-speed), not the body.
      recordedBy: username,
    },
  });

  return NextResponse.json(entry, { status: 201 });
}
