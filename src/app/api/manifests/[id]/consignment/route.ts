import { ownerOnly, getRequestUser } from "@/lib/auth";
import { getConsignmentLedger } from "@/lib/consignmentLedger";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// What's owed to this manifest's consignment supplier (src/lib/
// consignmentLedger.ts). Owner only: it's the money side of the deal.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const ledger = await getConsignmentLedger(id);
  if (!ledger) return NextResponse.json({ error: "This manifest isn't on consignment." }, { status: 404 });
  return NextResponse.json(ledger);
}

// Record a payment to the supplier: { amount, paidAt?, note? }.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Enter the amount you paid." }, { status: 400 });
  }
  const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
  if (Number.isNaN(paidAt.getTime())) return NextResponse.json({ error: "That date isn't valid." }, { status: 400 });
  const manifest = await prisma.manifest.findUnique({ where: { id }, select: { consignment: true } });
  if (!manifest?.consignment) return NextResponse.json({ error: "This manifest isn't on consignment." }, { status: 404 });

  await prisma.consignmentPayment.create({
    data: {
      manifestId: id,
      amount,
      paidAt,
      note: typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null,
      recordedBy: getRequestUser(request)?.username ?? null,
    },
  });
  return NextResponse.json(await getConsignmentLedger(id));
}

// Remove a payment entered by mistake: ?payment=<id>.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;
  const paymentId = request.nextUrl.searchParams.get("payment");
  if (!paymentId) return NextResponse.json({ error: "Which payment?" }, { status: 400 });
  await prisma.consignmentPayment.deleteMany({ where: { id: paymentId, manifestId: id } });
  return NextResponse.json(await getConsignmentLedger(id));
}
