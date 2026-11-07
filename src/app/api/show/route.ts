import { logActivity } from "@/lib/activityLog";
import { getRequestUser } from "@/lib/auth";
import { errorResponse } from "@/lib/warehouse/stations";
import { listShows, whatnotConfigured, WhatnotError } from "@/lib/whatnot";
import { markSortedByHand, nextBoxForBuyer, refreshShowOrders, setSoloMode, showFeed, sortScan } from "@/lib/whatnotShow";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// The Whatnot show screen (/show; Cristian, 2026-11-07): which buyer's show
// box each sold item goes in. Every signed-in user (the runner may be an
// employee); no prices or money here. GET ?showId= is the screen's feed
// (also checks Whatnot for orders the webhook hasn't brought yet); no
// showId = the shows to pick from.
export async function GET(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const showId = request.nextUrl.searchParams.get("showId");
  try {
    if (!showId) {
      if (!whatnotConfigured()) return NextResponse.json({ shows: [], connected: false });
      const [live, scheduled] = await Promise.all([listShows("live"), listShows("scheduled")]);
      return NextResponse.json({
        connected: true,
        owner: user.role === "owner",
        shows: [...live, ...scheduled].map((s) => ({ id: s.id, title: s.title, status: s.status, startsAt: s.scheduled_start_at })),
      });
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(showId)) return NextResponse.json({ error: "Bad show id." }, { status: 400 });
    if (whatnotConfigured()) await refreshShowOrders(showId).catch((e) => console.error("[show] refresh", e));
    return NextResponse.json({ ...(await showFeed(showId)), owner: user.role === "owner" });
  } catch (e) {
    return failed(e);
  }
}

// POST { action, ... }:
//   "scan"     { showId, code, refresh? }: the runner scanned a sold item.
//   "box_full" { buyerId }: that buyer gets another box.
//   "by_hand"  { saleId }: a sale the app can't scan is in its box.
//   "solo"     { on }: solo mode (owner only).
export async function POST(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await request.json().catch(() => null)) ?? {};
  const str = (v: unknown, max = 128) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  try {
    if (body.action === "scan") {
      const showId = str(body.showId);
      const code = str(body.code, 64);
      if (!showId || !code) return NextResponse.json({ error: "Send showId and code." }, { status: 400 });
      return NextResponse.json(await sortScan(showId, code, user.username, { refresh: body.refresh === true }));
    }
    if (body.action === "box_full") {
      const buyerId = str(body.buyerId);
      if (!buyerId) return NextResponse.json({ error: "Send buyerId." }, { status: 400 });
      const box = await nextBoxForBuyer(buyerId);
      return NextResponse.json({ box });
    }
    if (body.action === "by_hand") {
      const saleId = str(body.saleId);
      if (!saleId) return NextResponse.json({ error: "Send saleId." }, { status: 400 });
      return NextResponse.json({ box: await markSortedByHand(saleId, user.username) });
    }
    if (body.action === "solo") {
      if (user.role !== "owner") return NextResponse.json({ error: "Only the owner can switch solo mode." }, { status: 403 });
      await setSoloMode(body.on === true);
      await logActivity(
        { request },
        { action: "whatnot.show_solo", summary: `Whatnot show solo mode ${body.on === true ? "on" : "off"}`, targetType: "setting", targetId: "whatnot.showSolo" }
      );
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return failed(e);
  }
}

// Our own messages (and Whatnot's) go to the screen; anything else is
// logged and shown as a plain "try again", never raw database text.
function failed(e: unknown) {
  try {
    return errorResponse(e);
  } catch {
    console.error("[show]", e);
    if (e instanceof WhatnotError) return NextResponse.json({ error: e.message }, { status: 502 });
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
}
