import { randomUUID } from "crypto";
import { buildAuthorizeUrl } from "@/lib/ebay";
import { NextRequest, NextResponse } from "next/server";

// Kicks off eBay's Authorization Code Grant — redirects to eBay's consent
// screen. A random state value goes in a short-lived cookie so the callback
// can confirm the response actually came from a flow we started (CSRF).
export async function GET(request: NextRequest) {
  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl(randomUUID());
  } catch (e) {
    // Missing env var (e.g. Cristian clicked Connect before finishing the
    // .env.local setup) — send him back with a real message instead of
    // Next's generic 500 page.
    const settingsUrl = new URL("/settings", request.url);
    settingsUrl.searchParams.set("ebay", "error");
    settingsUrl.searchParams.set(
      "ebayMessage",
      e instanceof Error ? e.message : "eBay isn't configured yet."
    );
    return NextResponse.redirect(settingsUrl);
  }

  const state = new URL(authorizeUrl).searchParams.get("state")!;
  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set("ebay_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
