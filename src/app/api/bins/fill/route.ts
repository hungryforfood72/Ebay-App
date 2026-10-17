import { getRequestUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { placeInBin, WarehouseError } from "@/lib/warehouse/bins";
import { classifyScan, normalizeCode } from "@/lib/warehouse/codes";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, getBinDetail, ITEM_ROW_SELECT, lockItemRoom, ON_HAND_SQL, readCode, toItemRow } from "../shared";
import { openForFilling } from "./shared";

const WAITING_LIMIT = 300;

// "Waiting to be binned": warehouse-mode items (ES label) whose bins hold
// fewer units than are physically on hand (ON_HAND_SQL: listed minus sold
// in person minus picked; a sold-out listing can still have bags waiting
// to be picked). Pulled (expired) listings are left out: those bags get
// pulled, not binned. Every load together, oldest first: the label already says
// which item it is, so binning never asks for a manifest (the manifest
// title is only shown as small info).
// -> { items: [{ item, loose, manifest }], count, looseUnits }.
export async function GET() {
  const rows = await prisma.$queryRaw<{ id: string; loose: number }[]>`
    SELECT id, loose FROM (
      SELECT i.id, i."createdAt",
        (${ON_HAND_SQL} - COALESCE((SELECT SUM(bc.units) FROM "BinContent" bc WHERE bc."itemId" = i.id), 0))::int AS loose
      FROM "Item" i
      WHERE i.sku ~ '^ES[0-9]+$' AND i.status <> 'expired'
    ) t
    WHERE loose > 0
    ORDER BY "createdAt" ASC`;
  const shown = rows.slice(0, WAITING_LIMIT);
  const items = await prisma.item.findMany({
    where: { id: { in: shown.map((r) => r.id) } },
    select: { ...ITEM_ROW_SELECT, manifest: { select: { title: true } } },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  return NextResponse.json({
    items: shown.flatMap((r) => {
      const i = byId.get(r.id);
      return i ? [{ item: toItemRow(i), loose: r.loose, manifest: i.manifest?.title ?? null }] : [];
    }),
    count: rows.length,
    looseUnits: rows.reduce((sum, r) => sum + r.loose, 0),
  });
}

// Binning station: one scanned bag label = one unit into the open bin.
// { binCode, itemCode } -> { item, reopened, ...BinDetail }. Refuses a
// label once every unit still around is already in a bin (usually an
// extra or reprinted label). Filling a closed bin reopens it.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const binCode = readCode(body.binCode);
  const itemCode = normalizeCode(readCode(body.itemCode));
  if (!binCode) return NextResponse.json({ error: "Scan a bin first." }, { status: 400 });
  if (classifyScan(itemCode) !== "item") {
    return NextResponse.json(
      { error: "Scan the bag's item label (starts with ES), not the product barcode." },
      { status: 400 }
    );
  }
  const by = getRequestUser(request)?.username ?? null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const found = await tx.item.findUnique({ where: { sku: itemCode }, select: { id: true } });
      if (!found) throw new WarehouseError(`No item with label ${itemCode}.`, 404);
      const { bin, wasClosed } = await openForFilling(tx, binCode);
      const { item, onHand, room, bins } = await lockItemRoom(tx, found.id);
      if (item.status === "expired") throw new WarehouseError(`${itemCode} was pulled for expiry. Set it aside.`, 409);
      if (room <= 0) {
        throw new WarehouseError(
          onHand === 0
            ? `${itemCode} has none left to bin (all sold or picked). Extra label?`
            : `All ${onHand} of ${itemCode} ${onHand === 1 ? "is" : "are"} already in bins (${bins.join(", ")}). Extra label?`,
          409
        );
      }
      await placeInBin(tx, { itemId: found.id, binCode: bin.code, units: 1, by, note: "Binned" });
      return { itemId: found.id, binCode: bin.code, reopened: wasClosed };
    });
    const [detail, item] = await Promise.all([
      getBinDetail(result.binCode),
      prisma.item.findUniqueOrThrow({ where: { id: result.itemId }, select: ITEM_ROW_SELECT }),
    ]);
    return NextResponse.json({ item: toItemRow(item), reopened: result.reopened, ...detail });
  } catch (e) {
    return binsErrorResponse(e);
  }
}
