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

  // The review page's "Mark Ready" button blocks items with no category, but
  // that's a client-side check — belt-and-suspenders here too, since a real
  // upload failed with "missing required input tag <Item.PrimaryCategory.
  // CategoryID>" for an item that reached export without one. Export what's
  // actually exportable and leave the rest in "ready" rather than failing
  // the whole batch over one bad item.
  // Same belt-and-suspenders for condition — a real upload failed with
  // "Item condition is required for this category" for an item that reached
  // export with condition still unset.
  const exportableItems = readyItems.filter((i) => i.categoryId && i.condition);
  const skippedItems = readyItems.filter((i) => !i.categoryId || !i.condition);

  if (exportableItems.length === 0) {
    return NextResponse.json(
      { error: "No ready items have both a category and a condition set — nothing to export." },
      { status: 400 }
    );
  }

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.exportBatch.create({
      data: { exportedBy: body.exportedBy ?? null },
    });

    await tx.item.updateMany({
      where: { id: { in: exportableItems.map((i) => i.id) } },
      data: {
        status: "exported",
        exportBatchId: created.id,
        exportedAt: new Date(),
      },
    });

    return created;
  });

  const csv = itemsToFileExchangeCsv(exportableItems);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="ebay-export-${batch.id}.csv"`,
      "X-Skipped-Incomplete": String(skippedItems.length),
    },
  });
}
