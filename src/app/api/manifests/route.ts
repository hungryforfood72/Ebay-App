import { prisma } from "@/lib/prisma";
import { parseManifestCsv } from "@/lib/manifestParsers";
import { NextRequest, NextResponse } from "next/server";

// ?purchased=false returns Analyzer candidates (not yet bought); anything
// else (including omitted) returns real, bought manifests — the default a
// plain /api/manifests call has always meant, kept that way so the
// existing Manifests page's fetch doesn't need to change.
export async function GET(request: NextRequest) {
  const purchased = request.nextUrl.searchParams.get("purchased") !== "false";
  const manifests = await prisma.manifest.findMany({
    where: { purchased },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { lines: true, items: true } } },
  });
  return NextResponse.json(manifests);
}

// Upload + parse a manifest CSV. csvContent is sent as plain text (read
// client-side via FileReader) rather than multipart — simple enough for a
// CSV and consistent with how small text payloads are handled elsewhere.
// purchased defaults true (a real, bought load) — the Analyzer's upload
// flow is the only caller that ever passes false.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const title = String(body.title ?? "").trim();
  const csvContent = String(body.csvContent ?? "");
  const purchased = body.purchased !== false;

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
      purchased,
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
