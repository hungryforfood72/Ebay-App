import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { keyLabel, lineKey } from "@/lib/upcMatch";
import { WarehouseError } from "@/lib/warehouse/bins";
import { errorResponse } from "@/lib/warehouse/stations";
import { NextRequest, NextResponse } from "next/server";

const MAX_RESULTS = 10;

// The sort station's "search by name" (Cristian, 2026-10-24: products on
// the medical load with no UPC and no Item #). GET ?manifestId=&q= ->
// { results: [{ key, lineId, description, label }] }: the load's products whose
// name has every word typed (any order, any case), or whose UPC / Item #
// contains it. key is the line's key (lineKey); the page runs it through
// the normal sort check, same as a scan. One result per key, at most 10,
// products without a UPC first (they're why this exists). The List page
// uses it too (2026-10-25), linking the item to lineId.
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    const params = request.nextUrl.searchParams;
    const manifestId = params.get("manifestId") ?? "";
    const q = (params.get("q") ?? "").trim().toLowerCase();
    if (!manifestId) throw new WarehouseError("Pick the load first.");
    if (q.length < 2) return NextResponse.json({ results: [] });

    const lines = await prisma.manifestLine.findMany({
      where: { manifestId },
      select: { id: true, upc: true, supplierSku: true, description: true },
      orderBy: { sortOrder: "asc" },
    });
    const words = q.split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    const results: { key: string; lineId: string; description: string; label: string; hasUpc: boolean }[] = [];
    for (const l of lines) {
      const key = lineKey(l);
      if (!key || seen.has(key)) continue;
      const name = l.description.toLowerCase();
      const codes = `${l.upc ?? ""} ${l.supplierSku ?? ""}`.toLowerCase();
      if (!words.every((w) => name.includes(w)) && !codes.includes(q)) continue;
      seen.add(key);
      results.push({ key, lineId: l.id, description: l.description, label: keyLabel(key), hasUpc: Boolean(l.upc?.trim()) });
    }
    results.sort((a, b) => Number(a.hasUpc) - Number(b.hasUpc));
    return NextResponse.json({
      results: results.slice(0, MAX_RESULTS).map(({ key, lineId, description, label }) => ({ key, lineId, description, label })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
