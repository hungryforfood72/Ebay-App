import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// ONE-TIME TOOL: recent manifests the counting tool can open (the
// combined Costco file is uploaded in the Analyzer first, not run yet).
// Removal: see src/app/api/one-time/item-lookup.
export async function GET() {
  const manifests = await prisma.manifest.findMany({
    orderBy: { createdAt: "desc" },
    take: 15,
    select: {
      id: true,
      title: true,
      createdAt: true,
      _count: { select: { lines: true } },
      sourcingEvaluations: { orderBy: { startedAt: "desc" }, select: { status: true }, take: 1 },
    },
  });
  return NextResponse.json({
    manifests: manifests.map((m) => ({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt.toISOString(),
      lines: m._count.lines,
      analyzer: m.sourcingEvaluations[0]?.status ?? null,
    })),
  });
}
