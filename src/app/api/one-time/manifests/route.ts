import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// ONE-TIME TOOL: the consignment loads the item lookup can open, newest
// first, and whether the Analyzer has finished on each (the TAKE / LEAVE
// answers come from it). Removal: see src/app/api/one-time/item-lookup.
export async function GET() {
  const manifests = await prisma.manifest.findMany({
    where: { consignment: true },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      createdAt: true,
      _count: { select: { lines: true } },
      sourcingEvaluations: { where: { status: "complete" }, select: { id: true }, take: 1 },
    },
  });
  return NextResponse.json({
    manifests: manifests.map((m) => ({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt.toISOString(),
      lines: m._count.lines,
      analyzed: m.sourcingEvaluations.length > 0,
    })),
  });
}
