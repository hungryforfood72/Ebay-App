import { logActivity } from "@/lib/activityLog";
import { getRequestUser } from "@/lib/auth";
import { buildConsignmentPickList } from "@/lib/consignment";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// ONE-TIME TOOL (Cristian, 2026-10-17): count the leftover Costco food
// before running the Analyzer. The manifest has Costco's Item # but no UPC,
// and its quantities are the original loads, not what's left. So for each
// product he has: find it by Item # or name, scan its UPC, type how many.
// "Done counting" removes the products he didn't find, then the Analyzer
// runs on real UPCs and real counts. Results come back here as Sell / Dud
// (the consignment pick list's rules with nobody else's share).
//
// Counting progress lives in one AppSetting row per manifest, so the tool
// adds no tables. To remove the tool: delete src/app/one-time and
// src/app/api/one-time. The UPCs and counts it saved stay on the manifest.

type CountState = {
  // lineId -> what was counted (count 0 = looked, none left)
  counted: Record<string, { count: number; upc: string | null; originalQty: number; by: string | null; at: string }>;
  finished: boolean;
};

const stateKey = (manifestId: string) => `oneTime.costcoCount.${manifestId}`;

async function readState(manifestId: string): Promise<CountState> {
  const row = await prisma.appSetting.findUnique({ where: { key: stateKey(manifestId) } });
  return row ? (JSON.parse(row.value) as CountState) : { counted: {}, finished: false };
}

// Read-modify-write under a lock, so two phones counting at once can't
// overwrite each other's progress.
async function updateState(manifestId: string, change: (s: CountState) => void): Promise<CountState> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${stateKey(manifestId)}::text))`;
    const row = await tx.appSetting.findUnique({ where: { key: stateKey(manifestId) } });
    const state: CountState = row ? JSON.parse(row.value) : { counted: {}, finished: false };
    change(state);
    const value = JSON.stringify(state);
    await tx.appSetting.upsert({ where: { key: stateKey(manifestId) }, create: { key: stateKey(manifestId), value }, update: { value } });
    return state;
  });
}

const cleanUpc = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manifest = await prisma.manifest.findUnique({ where: { id }, select: { id: true, title: true } });
  if (!manifest) return NextResponse.json({ error: "That manifest isn't there anymore." }, { status: 404 });
  const [lines, state, evaluation] = await Promise.all([
    prisma.manifestLine.findMany({
      where: { manifestId: id },
      orderBy: { sortOrder: "asc" },
      select: { id: true, supplierSku: true, description: true, upc: true, expectedQuantity: true, retailPrice: true },
    }),
    readState(id),
    prisma.sourcingEvaluation.findFirst({ where: { manifestId: id }, orderBy: { startedAt: "desc" }, select: { status: true } }),
  ]);

  // After the Analyzer: Sell / Dud, with everything kept (0% to anyone else).
  let results = null;
  if (evaluation?.status === "complete") {
    const owner = getRequestUser(request)?.role === "owner";
    const list = await buildConsignmentPickList(id, 0);
    if (list) {
      const row = (p: (typeof list.picks)[number]) => ({
        description: p.description,
        upc: p.upc,
        itemNumbers: p.itemNumbers,
        units: p.availableUnits,
        sellUnits: p.takeUnits,
        reason: p.reason,
        netPerUnit: owner ? p.netPerUnit : null,
        monthsToSell: p.monthsToSellThrough,
      });
      results = { sell: list.picks.map(row), dud: list.skipped.map(row), profit: owner ? list.yourProfit : null };
    }
  }

  return NextResponse.json({
    title: manifest.title,
    lines: lines.map((l) => ({ ...l, retailPrice: Number(l.retailPrice) })),
    counted: state.counted,
    finished: state.finished,
    analyzer: evaluation?.status ?? null,
    results,
  });
}

// { action: "count", lineId, upc, count }  a product found (count 0 = none left)
// { action: "add", upc, description, count, unitRetail }  something not on the manifest
// { action: "finish" }  remove every product not counted (or counted 0)
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const by = getRequestUser(request)?.username ?? null;
  const state = await readState(id);
  if (state.finished && body.action !== "finish") {
    return NextResponse.json({ error: "Counting is already done for this load." }, { status: 409 });
  }

  if (body.action === "count") {
    const count = Math.round(Number(body.count));
    const upc = cleanUpc(body.upc);
    if (!Number.isFinite(count) || count < 0 || count > 10000) return NextResponse.json({ error: "Enter how many you have (0 if none)." }, { status: 400 });
    if (count > 0 && (upc.length < 8 || upc.length > 14)) return NextResponse.json({ error: "Scan the UPC on the product first." }, { status: 400 });
    const line = await prisma.manifestLine.findFirst({ where: { id: body.lineId, manifestId: id } });
    if (!line) return NextResponse.json({ error: "That product isn't on this manifest." }, { status: 404 });
    const originalQty = state.counted[line.id]?.originalQty ?? line.expectedQuantity;
    await prisma.manifestLine.update({
      where: { id: line.id },
      data: {
        ...(upc ? { upc } : {}),
        expectedQuantity: count,
        extendedRetail: Math.round(Number(line.retailPrice) * count * 100) / 100,
      },
    });
    const next = await updateState(id, (s) => {
      s.counted[line.id] = { count, upc: upc || line.upc, originalQty, by, at: new Date().toISOString() };
    });
    await logActivity(
      { request },
      {
        action: "one-time.count",
        summary: `${line.description} (Item # ${line.supplierSku ?? "none"}): ${count} on hand${upc ? `, UPC ${upc}` : ""}`,
        targetType: "manifestLine",
        targetId: line.id,
        before: { upc: line.upc, qty: line.expectedQuantity },
        after: { upc: upc || line.upc, qty: count },
      }
    );
    return NextResponse.json({ counted: next.counted });
  }

  if (body.action === "add") {
    const count = Math.round(Number(body.count));
    const upc = cleanUpc(body.upc);
    const description = typeof body.description === "string" ? body.description.trim().slice(0, 200) : "";
    const retail = Number(body.unitRetail) > 0 ? Math.round(Number(body.unitRetail) * 100) / 100 : 0;
    if (upc.length < 8 || upc.length > 14) return NextResponse.json({ error: "Scan the UPC on the product." }, { status: 400 });
    if (!description) return NextResponse.json({ error: "Type what it is." }, { status: 400 });
    if (!Number.isFinite(count) || count < 1) return NextResponse.json({ error: "Enter how many you have." }, { status: 400 });
    const last = await prisma.manifestLine.findFirst({ where: { manifestId: id }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    const line = await prisma.manifestLine.create({
      data: {
        manifestId: id,
        description,
        upc,
        expectedQuantity: count,
        retailPrice: retail,
        extendedRetail: Math.round(retail * count * 100) / 100,
        sortOrder: (last?.sortOrder ?? 0) + 1,
      },
    });
    const next = await updateState(id, (s) => {
      s.counted[line.id] = { count, upc, originalQty: 0, by, at: new Date().toISOString() };
    });
    await logActivity({ request }, { action: "one-time.add", summary: `Added ${description} (UPC ${upc}), ${count} on hand`, targetType: "manifestLine", targetId: line.id, after: { upc, count, retail } });
    return NextResponse.json({ counted: next.counted, line: { id: line.id, supplierSku: null, description, upc, expectedQuantity: count, retailPrice: retail } });
  }

  if (body.action === "finish") {
    if (state.finished) return NextResponse.json({ removed: 0 });
    const keep = Object.entries(state.counted)
      .filter(([, c]) => c.count > 0)
      .map(([lineId]) => lineId);
    if (keep.length === 0) return NextResponse.json({ error: "Nothing's been counted yet." }, { status: 400 });
    const { count: removed } = await prisma.manifestLine.deleteMany({ where: { manifestId: id, id: { notIn: keep } } });
    await updateState(id, (s) => {
      s.finished = true;
    });
    await logActivity({ request }, { action: "one-time.finish", summary: `Done counting: kept ${keep.length} products, removed ${removed} not found`, targetType: "manifest", targetId: id, after: { kept: keep.length, removed } });
    return NextResponse.json({ removed, kept: keep.length });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
