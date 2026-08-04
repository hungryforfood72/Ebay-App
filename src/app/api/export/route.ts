import { prisma } from "@/lib/prisma";
import { itemsToFileExchangeCsv } from "@/lib/csv";
import { NextRequest, NextResponse } from "next/server";

// Bundles every "ready" item into a new export batch, marks them exported,
// and returns the File Exchange CSV as a download.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));

  const readyItems = await prisma.item.findMany({
    where: { status: "ready" },
  });

  if (readyItems.length === 0) {
    return NextResponse.json(
      { error: "No items are marked ready to list." },
      { status: 400 }
    );
  }

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.exportBatch.create({
      data: { exportedBy: body.exportedBy ?? null },
    });

    await tx.item.updateMany({
      where: { id: { in: readyItems.map((i) => i.id) } },
      data: {
        status: "exported",
        exportBatchId: created.id,
        exportedAt: new Date(),
      },
    });

    return created;
  });

  const csv = itemsToFileExchangeCsv(readyItems);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="ebay-export-${batch.id}.csv"`,
    },
  });
}
