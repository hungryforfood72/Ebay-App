import { getRequestUser } from "@/lib/auth";
import { buildConsignmentPickList, DEFAULT_CONSIGNMENT_SUPPLIER_PCT } from "@/lib/consignment";
import { prisma } from "@/lib/prisma";
import { upcMatchKeys } from "@/lib/upcMatch";
import { NextRequest, NextResponse } from "next/server";

// Pick mode for a consignment load (/pick/[id]): every product's TAKE or
// LEAVE answer from the pick list (src/lib/consignment.ts), with match keys
// so the page answers each scan instantly on the phone. Cristian takes all
// of every TAKE product, so no quantities. No money in here: anyone signed
// in can help pick.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manifest = await prisma.manifest.findUnique({
    where: { id },
    select: { title: true, consignment: true, consignmentSupplierPct: true },
  });
  if (!manifest?.consignment) return NextResponse.json({ error: "This manifest isn't on consignment." }, { status: 404 });
  const list = await buildConsignmentPickList(id, manifest.consignmentSupplierPct ?? DEFAULT_CONSIGNMENT_SUPPLIER_PCT);
  if (!list) return NextResponse.json({ error: "Run the Analyzer on this load first." }, { status: 409 });

  const [scans, recent] = await Promise.all([
    prisma.consignmentPickScan.findMany({
      where: { manifestId: id, decision: "take", productKey: { not: null } },
      select: { productKey: true },
      distinct: ["productKey"],
    }),
    prisma.consignmentPickScan.findMany({ where: { manifestId: id }, orderBy: { scannedAt: "desc" }, take: 15 }),
  ]);

  const product = (p: (typeof list.picks)[number], decision: "take" | "leave") => ({
    key: p.estimateId,
    decision,
    description: p.description,
    upc: p.upc,
    itemNumbers: p.itemNumbers,
    matchKeys: upcMatchKeys(p.upc),
    reason: decision === "leave" ? p.reason : null,
  });
  return NextResponse.json({
    title: manifest.title,
    products: [...list.picks.map((p) => product(p, "take")), ...list.skipped.map((p) => product(p, "leave"))],
    foundKeys: scans.map((s) => s.productKey),
    recent: recent.map((r) => ({ id: r.id, code: r.code, productKey: r.productKey, decision: r.decision, scannedAt: r.scannedAt })),
  });
}

// Log a scan: { code, productKey, decision }.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const decision = ["take", "leave", "unknown"].includes(body.decision) ? body.decision : null;
  const code = typeof body.code === "string" ? body.code.trim().slice(0, 64) : "";
  if (!decision || !code) return NextResponse.json({ error: "Missing scan." }, { status: 400 });
  const scan = await prisma.consignmentPickScan.create({
    data: {
      manifestId: id,
      code,
      productKey: typeof body.productKey === "string" ? body.productKey : null,
      decision,
      scannedBy: getRequestUser(request)?.username ?? null,
    },
  });
  return NextResponse.json({ id: scan.id });
}
