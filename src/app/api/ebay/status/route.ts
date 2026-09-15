import { getEbayEnvironment } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const environment = getEbayEnvironment();
  const token = await prisma.ebayAuthToken.findUnique({ where: { environment } });
  return NextResponse.json({
    environment,
    connected: Boolean(token),
    connectedAt: token?.updatedAt ?? null,
  });
}

export async function DELETE() {
  const environment = getEbayEnvironment();
  await prisma.ebayAuthToken.deleteMany({ where: { environment } });
  return NextResponse.json({ ok: true });
}
