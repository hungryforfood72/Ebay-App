import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findBin, moveBinContents, WarehouseError } from "@/lib/warehouse/bins";
import { normalizeCode } from "@/lib/warehouse/codes";
import { resolveBinScan } from "@/lib/warehouse/shelves";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, readCode, summarizeBins } from "../shared";

// Moves only some items from one bin to another (either can be an
// oversized shelf's label):
// { fromBinCode, toBinCode, itemIds?: string[], itemCodes?: string[] } ->
// { itemsMoved, unitsMoved, fromEmpty, from, to }. itemCodes are what the
// handheld scanned: an item label (ES000123), or the UPC for an older item
// put away without a label, matched only against what's in the source bin.
// Each item moves with all its units in that bin.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const fromBinCode = readCode(body.fromBinCode);
  const toBinCode = readCode(body.toBinCode);
  if (!fromBinCode || !toBinCode) {
    return NextResponse.json({ error: "Scan the bin to move from and the bin to move into." }, { status: 400 });
  }
  const itemIds: string[] = Array.isArray(body.itemIds) ? body.itemIds.filter((v: unknown) => typeof v === "string") : [];
  const itemCodes: string[] = Array.isArray(body.itemCodes)
    ? body.itemCodes.filter((v: unknown) => typeof v === "string" && v.trim()).map((v: string) => normalizeCode(v))
    : [];
  if (itemIds.length === 0 && itemCodes.length === 0) {
    return NextResponse.json({ error: "Scan at least one item to move." }, { status: 400 });
  }

  try {
    if (itemCodes.length > 0) {
      const from = await findBin(prisma, await resolveBinScan(prisma, fromBinCode));
      const contents = await prisma.binContent.findMany({
        where: { binId: from.id },
        select: { item: { select: { id: true, sku: true, upc: true } } },
      });
      for (const code of itemCodes) {
        const matches = contents.filter((c) => c.item.sku.toUpperCase() === code || c.item.upc === code);
        if (matches.length === 0) throw new WarehouseError(`${code} isn't in ${from.code}.`);
        if (matches.length > 1) {
          throw new WarehouseError(`More than one item in ${from.code} has UPC ${code}. Scan the item label instead.`);
        }
        itemIds.push(matches[0].item.id);
      }
    }
    const result = await moveBinContents({
      fromBinCode,
      toBinCode,
      itemIds: [...new Set(itemIds)],
      by: getRequestUser(request)?.username ?? null,
      unshelveEmptiedFrom: true,
    });
    const bins = await summarizeBins({ code: { in: [result.fromCode, result.toCode] } });
    return NextResponse.json({
      ...result,
      from: bins.find((b) => b.code === result.fromCode) ?? null,
      to: bins.find((b) => b.code === result.toCode) ?? null,
    });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
