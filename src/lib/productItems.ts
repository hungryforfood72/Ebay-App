import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { ITEM_KEY_PREFIX, LINE_KEY_PREFIX, isExactKey } from "./upcMatch";

// A product on a manifest is a UPC, or for one with no UPC its line key
// ("item:<Item #>" / "line:<id>", see upcMatch.ts). Items listed of a no-UPC
// product have no upc; they point at the line they were picked from
// (Item.manifestLineId, Cristian 2026-10-25). These let the counts that go
// by UPC (pack card, sort boxes) find them too. Server only.

// The manifest lines a line key stands for (none for a plain UPC).
export async function linesForKey(manifestId: string, key: string) {
  const select = { id: true, description: true, supplierSku: true, expectedQuantity: true, retailPrice: true, category: true } as const;
  if (key.startsWith(ITEM_KEY_PREFIX)) {
    return prisma.manifestLine.findMany({
      where: { manifestId, supplierSku: key.slice(ITEM_KEY_PREFIX.length), OR: [{ upc: null }, { upc: "" }] },
      select,
      orderBy: { sortOrder: "asc" },
    });
  }
  if (key.startsWith(LINE_KEY_PREFIX)) {
    return prisma.manifestLine.findMany({ where: { manifestId, id: key.slice(LINE_KEY_PREFIX.length) }, select });
  }
  return [];
}

// Where-clause for the single (non-bundle) Items of this product on the
// manifest.
export async function productItemsWhere(manifestId: string, upc: string): Promise<Prisma.ItemWhereInput> {
  if (!isExactKey(upc)) return { manifestId, upc, isBundle: false };
  const lineIds = (await linesForKey(manifestId, upc)).map((l) => l.id);
  return { manifestId, isBundle: false, OR: [{ upc }, { manifestLineId: { in: lineIds } }] };
}
