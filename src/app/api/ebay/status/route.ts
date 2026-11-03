import { ownerOnly } from "@/lib/auth";
import { getEbayEnvironment, getMissingScopes } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const environment = getEbayEnvironment();
  const token = await prisma.ebayAuthToken.findUnique({ where: { environment } });
  const missingScopes = token ? await getMissingScopes() : [];
  return NextResponse.json({
    environment,
    connected: Boolean(token),
    connectedAt: token?.updatedAt ?? null,
    missingScopes,
  });
}

export async function DELETE(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const environment = getEbayEnvironment();
  await prisma.ebayAuthToken.deleteMany({ where: { environment } });
  return NextResponse.json({ ok: true });
}
