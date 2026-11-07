import { getRequestUser } from "@/lib/auth";
import { errorResponse } from "@/lib/warehouse/stations";
import {
  buyerForBox,
  checkLabels,
  closeEmpty,
  packByHand,
  packList,
  packScan,
  packView,
  putBack,
  recentShows,
  reprintLabels,
  requestLabel,
} from "@/lib/whatnotPack";
import { WhatnotError } from "@/lib/whatnot";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 120;

// Packing mode for a Whatnot show (/show/pack; Cristian, 2026-11-07). Any
// signed-in user: packers may be employees. No prices or money.
// GET ?buyerId= one buyer's order; ?showId= the show's list; neither = shows.
export async function GET(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const buyerId = request.nextUrl.searchParams.get("buyerId");
  const showId = request.nextUrl.searchParams.get("showId");
  try {
    if (buyerId) return NextResponse.json(await packView(buyerId, { fresh: request.nextUrl.searchParams.get("fresh") === "1" }));
    if (showId) return NextResponse.json({ list: await packList(showId) });
    return NextResponse.json({ shows: await recentShows() });
  } catch (e) {
    return failed(e);
  }
}

// POST { action, ... }:
//   "open"        { code }: a show box's QR -> that buyer's order.
//   "scan"        { buyerId, code }: an item into the shipping box.
//   "by_hand"     { buyerId, orderItemId }: one the app can't scan is in.
//   "put_back"    { buyerId, saleId, binCode }: a cancelled one back in a bin.
//   "label"       { buyerId, stationId }: ask Whatnot for the label, print it.
//   "label_check" { buyerId }: print it if Whatnot has made it by now.
//   "reprint"     { buyerId, stationId }
//   "close_empty" { buyerId }: nothing left to ship, free the boxes.
export async function POST(request: NextRequest) {
  const user = getRequestUser(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await request.json().catch(() => null)) ?? {};
  const str = (v: unknown, max = 128) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  const buyerId = str(body.buyerId);
  const by = user.username;
  try {
    switch (body.action) {
      case "open": {
        const code = str(body.code, 64);
        if (!code) return NextResponse.json({ error: "Scan a show box." }, { status: 400 });
        return NextResponse.json(await packView(await buyerForBox(code), { fresh: true }));
      }
      case "scan": {
        const code = str(body.code, 64);
        if (!buyerId || !code) return NextResponse.json({ error: "Send buyerId and code." }, { status: 400 });
        return NextResponse.json(await packScan(buyerId, code, by));
      }
      case "by_hand": {
        const orderItemId = str(body.orderItemId);
        if (!buyerId || !orderItemId) return NextResponse.json({ error: "Send buyerId and orderItemId." }, { status: 400 });
        await packByHand(buyerId, orderItemId, by);
        return NextResponse.json({ ok: true });
      }
      case "put_back": {
        const saleId = str(body.saleId);
        const binCode = str(body.binCode, 40);
        if (!buyerId || !saleId || !binCode) return NextResponse.json({ error: "Send buyerId, saleId and binCode." }, { status: 400 });
        return NextResponse.json({ ok: true, binCode: await putBack(buyerId, saleId, binCode, by) });
      }
      case "label": {
        const stationId = str(body.stationId);
        if (!buyerId || !stationId) return NextResponse.json({ error: "Send buyerId and stationId." }, { status: 400 });
        return NextResponse.json(await requestLabel(buyerId, stationId, by));
      }
      case "label_check": {
        if (!buyerId) return NextResponse.json({ error: "Send buyerId." }, { status: 400 });
        return NextResponse.json(await checkLabels(buyerId));
      }
      case "reprint": {
        const stationId = str(body.stationId);
        if (!buyerId || !stationId) return NextResponse.json({ error: "Send buyerId and stationId." }, { status: 400 });
        return NextResponse.json({ printed: await reprintLabels(buyerId, stationId, by) });
      }
      case "close_empty": {
        if (!buyerId) return NextResponse.json({ error: "Send buyerId." }, { status: 400 });
        await closeEmpty(buyerId, by);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (e) {
    return failed(e);
  }
}

function failed(e: unknown) {
  try {
    return errorResponse(e);
  } catch {
    console.error("[show pack]", e);
    // Our own messages (and Whatnot's) go to the screen; never raw database text.
    if (e instanceof WhatnotError) return NextResponse.json({ error: e.message }, { status: 502 });
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
}
