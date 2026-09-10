import { prisma } from "@/lib/prisma";
import { parseManifestCsv } from "@/lib/manifestParsers";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  const manifests = await prisma.manifest.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { lines: true, items: true } } },
  });
  return NextResponse.json(manifests);
}

// Upload + parse a manifest CSV. csvContent is sent as plain text (read
// client-side via FileReader) rather than multipart — simple enough for a
// CSV and consistent with how small text payloads are handled elsewhere.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const title = String(body.title ?? "").trim();
  const csvContent = String(body.csvContent ?? "");

  if (!title) {
    return NextResponse.json({ error: "Title is required." }, { status: 400 });
  }
  if (!csvContent.trim()) {
    return NextResponse.json({ error: "CSV content is required." }, { status: 400 });
  }

  const parsed = parseManifestCsv(csvContent);
  if (parsed.supplier === "unknown") {
    return NextResponse.json(
      { error: "Unrecognized manifest format — this isn't a BStock or Liquidation.com export we know how to read." },
      { status: 400 }
    );
  }
  if (parsed.lines.length === 0) {
    return NextResponse.json({ error: "No line items found in that file." }, { status: 400 });
  }

  const manifest = await prisma.manifest.create({
    data: {
      title,
      supplier: parsed.supplier,
      createdBy: body.createdBy ?? null,
      lines: {
        create: parsed.lines.map((l, index) => ({
          supplierSku: l.supplierSku,
          upc: l.upc,
          description: l.description,
          expectedQuantity: l.expectedQuantity,
          retailPrice: l.retailPrice,
          extendedRetail: l.extendedRetail,
          condition: l.condition,
          category: l.category,
          subcategory: l.subcategory,
          sortOrder: index,
        })),
      },
    },
  });

  return NextResponse.json(manifest, { status: 201 });
}
