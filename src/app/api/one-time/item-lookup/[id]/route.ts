import { logActivity } from "@/lib/activityLog";
import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// ONE-TIME TOOL (Cristian, 2026-10-17): the leftover Costco food loads have
// no UPCs on the manifest, only Costco's Item #. On /one-time/item-lookup/
// [id] he finds a product by Item # or name, sees TAKE / LEAVE from the
// consignment pick list, and scans the real UPC once he has it in hand,
// which is saved onto every manifest line with that Item #.
//
// To remove this tool: delete src/app/one-time and src/app/api/one-time,
// and the link marked ONE-TIME on src/app/manifests/[id]/page.tsx. Nothing
// else depends on it; the UPCs it saved stay on the manifest lines.

// UPCs already saved on this manifest, by Item #.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lines = await prisma.manifestLine.findMany({
    where: { manifestId: id, supplierSku: { not: null }, upc: { not: null } },
    select: { supplierSku: true, upc: true },
  });
  return NextResponse.json({ saved: Object.fromEntries(lines.map((l) => [l.supplierSku!, l.upc!])) });
}

// { itemNumber, upc, productKey, decision }: saves the UPC on the lines
// with that Item # and records it as found in pick mode's scan log.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const itemNumber = typeof body.itemNumber === "string" ? body.itemNumber.trim() : "";
  const upc = typeof body.upc === "string" ? body.upc.replace(/\D/g, "") : "";
  if (!itemNumber) return NextResponse.json({ error: "Which Item #?" }, { status: 400 });
  if (upc.length < 8 || upc.length > 14) return NextResponse.json({ error: `"${body.upc}" doesn't look like a UPC. Scan the barcode on the product.` }, { status: 400 });

  const lines = await prisma.manifestLine.findMany({ where: { manifestId: id, supplierSku: itemNumber }, select: { id: true, upc: true, description: true } });
  if (lines.length === 0) return NextResponse.json({ error: `Item # ${itemNumber} isn't on this manifest.` }, { status: 404 });

  await prisma.$transaction([
    prisma.manifestLine.updateMany({ where: { id: { in: lines.map((l) => l.id) } }, data: { upc } }),
    prisma.consignmentPickScan.create({
      data: {
        manifestId: id,
        code: upc,
        productKey: typeof body.productKey === "string" ? body.productKey : null,
        decision: body.decision === "leave" ? "leave" : "take",
        scannedBy: getRequestUser(request)?.username ?? null,
      },
    }),
  ]);
  await logActivity(
    { request },
    {
      action: "one-time.upc",
      summary: `Saved UPC ${upc} for Item # ${itemNumber} (${lines[0].description})`,
      targetType: "manifestLine",
      targetId: `${id}:${itemNumber}`,
      before: { upc: lines[0].upc },
      after: { upc },
    }
  );
  return NextResponse.json({ ok: true, upc });
}
