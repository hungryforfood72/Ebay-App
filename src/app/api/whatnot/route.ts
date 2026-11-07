import { logActivity } from "@/lib/activityLog";
import { getRequestUser, ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getItemLocations } from "@/lib/warehouse/bins";
import { getShow, listProducts, listShows, whatnotConfigured, type WhatnotShow } from "@/lib/whatnot";
import {
  applyBinShows,
  getCategoryMap,
  getCrossList,
  runWhatnotSync,
  setCategoryMap,
  setCrossList,
  type CategoryMap,
} from "@/lib/whatnotSync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

// The Whatnot page (owner only, here and in proxy.ts): connection, shows
// and the bins assigned to them, cross-listing status, the category map,
// and recent Whatnot sales with where each item is.
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const connected = whatnotConfigured();
  let shows: WhatnotShow[] = [];
  let showsError: string | null = null;
  if (connected) {
    try {
      const [live, scheduled] = await Promise.all([listShows("live"), listShows("scheduled")]);
      shows = [...live, ...scheduled];
    } catch (e) {
      showsError = e instanceof Error ? e.message : String(e);
    }
  }

  const [bins, binShows, crossList, categoryMap, onWhatnot, waiting, skipped, failed, sales] = await Promise.all([
    prisma.bin.findMany({
      where: { whatnot: true },
      orderBy: { code: "asc" },
      select: { id: true, code: true, shelfLabel: true, contents: { select: { units: true, item: { select: { whatnotPublishedAt: true, whatnotEndedAt: true } } } } },
    }),
    prisma.binShow.findMany({ include: { bin: { select: { code: true } } } }),
    getCrossList(),
    getCategoryMap(),
    prisma.item.count({ where: { whatnotPublishedAt: { not: null }, whatnotEndedAt: null } }),
    prisma.item.count({
      where: {
        whatnotOnly: false,
        OR: [{ whatnotProductId: null }, { whatnotPublishedAt: null, whatnotEndedAt: null }],
        whatnotSkipReason: null,
        whatnotError: null,
        status: { in: ["listed", "exported"] },
        quantity: { gt: prisma.item.fields.soldQuantity },
        expiredAt: null,
        pastDateAt: null,
        listingEndedAt: null,
      },
    }),
    prisma.item.groupBy({
      by: ["whatnotSkipReason"],
      where: { whatnotSkipReason: { not: null }, status: { in: ["listed", "exported"] } },
      _count: { _all: true },
    }),
    prisma.item.findMany({
      where: { whatnotError: { not: null }, whatnotEndedAt: null },
      select: { id: true, sku: true, finalTitle: true, whatnotError: true, whatnotOnly: true },
      take: 50,
    }),
    prisma.shopifySale.findMany({
      where: { channel: "whatnot", shopifyLineItemId: { startsWith: "whatnot:" } },
      orderBy: { soldAt: "desc" },
      take: 30,
      select: {
        id: true,
        quantity: true,
        revenue: true,
        soldAt: true,
        shopifyOrderName: true,
        item: { select: { id: true, sku: true, finalTitle: true, shelfLocation: true } },
      },
    }),
  ]);
  const locations = await getItemLocations(sales.map((s) => s.item));
  const showById = new Map(binShows.map((b) => [b.binId, b]));

  return NextResponse.json({
    connected,
    webhookReady: Boolean(process.env.WHATNOT_WEBHOOK_SECRET),
    shows: shows.map((s) => ({ id: s.id, title: s.title, status: s.status, startsAt: s.scheduled_start_at, url: s.url })),
    showsError,
    bins: bins.map((b) => {
      const assigned = showById.get(b.id);
      return {
        code: b.code,
        shelf: b.shelfLabel,
        units: b.contents.reduce((sum, c) => sum + c.units, 0),
        onWhatnot: b.contents.filter((c) => c.item.whatnotPublishedAt && !c.item.whatnotEndedAt).length,
        show: assigned ? { id: assigned.showId, title: assigned.showTitle, startsAt: assigned.showStartsAt } : null,
      };
    }),
    crossList,
    categoryMap,
    counts: { onWhatnot, waiting },
    skipped: skipped.map((s) => ({ reason: s.whatnotSkipReason, count: s._count._all })).sort((a, b) => b.count - a.count),
    failed,
    sales: sales.map((s) => ({
      id: s.id,
      order: s.shopifyOrderName,
      soldAt: s.soldAt,
      quantity: s.quantity,
      revenue: Number(s.revenue),
      sku: s.item.sku,
      title: s.item.finalTitle,
      bins: locations.get(s.item.id)?.bins.map((x) => (x.shelfLabel ? `${x.binCode} @ ${x.shelfLabel}` : x.binCode)) ?? [],
    })),
  });
}

// POST { action, ... }:
//   "assign"    { binCode, showId | null }: put a Whatnot bin on a show (or off).
//   "settings"  { crossList?, categoryMap? }
//   "retry"     clear Whatnot errors so the next run tries them again.
//   "sync"      run the Whatnot sync now.
//   "categories" read the categories on the account's Whatnot listings.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) ?? {};
  try {
    if (body.action === "assign") {
      const code = typeof body.binCode === "string" ? body.binCode.trim().toUpperCase() : "";
      const bin = code ? await prisma.bin.findUnique({ where: { code }, select: { id: true, code: true, whatnot: true } }) : null;
      if (!bin) return NextResponse.json({ error: "No bin with that code." }, { status: 404 });
      if (!bin.whatnot) return NextResponse.json({ error: `${bin.code} isn't a Whatnot bin.` }, { status: 400 });
      if (body.showId == null || body.showId === "") {
        await prisma.binShow.deleteMany({ where: { binId: bin.id } });
      } else {
        if (typeof body.showId !== "string") return NextResponse.json({ error: "Pick a show." }, { status: 400 });
        // The show's details come from Whatnot, not the page.
        const show = await getShow(body.showId);
        if (show.status === "ended" || show.status === "cancelled") {
          return NextResponse.json({ error: `That show is ${show.status}. Pick an upcoming one.` }, { status: 400 });
        }
        const data = {
          showId: show.id,
          showTitle: show.title.slice(0, 200),
          showStartsAt: show.scheduled_start_at ? new Date(show.scheduled_start_at) : null,
          assignedBy: getRequestUser(request)?.username ?? null,
          assignedAt: new Date(),
        };
        await prisma.binShow.upsert({ where: { binId: bin.id }, create: { binId: bin.id, ...data }, update: data });
      }
      const itemIds = (await prisma.binContent.findMany({ where: { binId: bin.id }, select: { itemId: true } })).map((c) => c.itemId);
      const errors = await applyBinShows(itemIds);
      await logActivity(
        { request },
        { action: "whatnot.bin_show", summary: `${bin.code} ${body.showId ? "assigned to a Whatnot show" : "taken off its Whatnot show"}`, targetType: "bin", targetId: bin.code }
      );
      return NextResponse.json({ ok: true, errors });
    }

    if (body.action === "settings") {
      if (typeof body.crossList === "boolean") await setCrossList(body.crossList);
      if (body.categoryMap) {
        const raw = body.categoryMap as Partial<CategoryMap>;
        const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
        const map: CategoryMap = {
          rules: (Array.isArray(raw.rules) ? raw.rules : [])
            .map((r) => ({ match: clean(r?.match, 120), categoryId: clean(r?.categoryId, 120), categoryName: clean(r?.categoryName, 120) }))
            .filter((r) => r.match && r.categoryId)
            .slice(0, 200),
          defaultId: clean(raw.defaultId, 120) || null,
          defaultName: clean(raw.defaultName, 120) || null,
        };
        await setCategoryMap(map);
      }
      await logActivity({ request }, { action: "whatnot.settings", summary: "Changed Whatnot settings", targetType: "setting", targetId: "whatnot" });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "retry") {
      const { count } = await prisma.item.updateMany({ where: { whatnotError: { not: null }, whatnotEndedAt: null }, data: { whatnotError: null } });
      return NextResponse.json({ ok: true, cleared: count });
    }

    if (body.action === "sync") {
      return NextResponse.json(await runWhatnotSync(240_000));
    }

    if (body.action === "categories") {
      const seen = new Map<string, { id: string; name: string | null; count: number; example: string }>();
      let cursor: string | undefined;
      for (let page = 0; page < 6; page++) {
        const res = await listProducts(cursor);
        for (const p of res.items) {
          const c = seen.get(p.category.id) ?? { id: p.category.id, name: p.category.name, count: 0, example: p.title };
          c.count++;
          seen.set(p.category.id, c);
        }
        if (!res.next) break;
        cursor = res.next;
      }
      return NextResponse.json({ categories: [...seen.values()].sort((a, b) => b.count - a.count) });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
