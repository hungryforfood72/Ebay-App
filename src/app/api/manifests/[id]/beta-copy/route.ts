import { prisma } from "@/lib/prisma";
import { ownerOnly } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

// Copies a manifest (bought or still in the Analyzer) into the Analyzer
// Beta: a new Manifest with analyzerBeta, purchased false, and the same
// lines, so the beta's eBay-compliant evaluation can run on it and be
// compared with the original's standard one. The original isn't touched.
// Only what the evaluation reads is copied; nothing scanned, sold or bid.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const { id } = await params;

  const source = await prisma.manifest.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  if (!source) return NextResponse.json({ error: "Manifest not found." }, { status: 404 });
  if (source.analyzerBeta) {
    return NextResponse.json({ error: "That's already a beta copy." }, { status: 400 });
  }

  const copy = await prisma.manifest.create({
    data: {
      title: `${source.title} (Beta)`,
      supplier: source.supplier,
      purchased: false,
      analyzerBeta: true,
      betaSourceId: source.id,
      lines: {
        create: source.lines.map((l) => ({
          supplierSku: l.supplierSku,
          upc: l.upc,
          description: l.description,
          expectedQuantity: l.expectedQuantity,
          retailPrice: l.retailPrice,
          extendedRetail: l.extendedRetail,
          condition: l.condition,
          category: l.category,
          subcategory: l.subcategory,
          sortOrder: l.sortOrder,
          piecesPerBox: l.piecesPerBox,
        })),
      },
    },
    select: { id: true, title: true },
  });
  return NextResponse.json(copy, { status: 201 });
}
