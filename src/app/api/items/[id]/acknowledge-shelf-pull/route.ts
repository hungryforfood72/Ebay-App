import { AuthError, getRequestUser, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { finishPull } from "@/lib/warehouse/pulls";
import { NextRequest, NextResponse } from "next/server";

// Finishes a shelf pull without scanning what's left. Since 2026-10-26
// pulls are scanned unit by unit on the Pull page (src/lib/warehouse/pulls.ts);
// this is its "Can't find the rest" ({ notFound: true }): the pull is done
// with what was found and the bins stop counting the rest. Either role,
// whoever is doing the pull. recordedBy comes from the session.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireUser(request);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const username = getRequestUser(request)?.username ?? null;
  const result = await finishPull(id, username, body?.notFound === true);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(await prisma.item.findUnique({ where: { id } }));
}
