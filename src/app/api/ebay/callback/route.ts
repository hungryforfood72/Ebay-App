import { exchangeCodeForToken, getEbayEnvironment } from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// eBay redirects here after the consent screen. Exchanges the auth code for
// tokens and upserts them keyed by environment, so reconnecting the same
// environment just refreshes the row rather than creating a duplicate.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const settingsUrl = new URL("/settings", request.url);

  if (searchParams.get("declined")) {
    settingsUrl.searchParams.set("ebay", "declined");
    return NextResponse.redirect(settingsUrl);
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = request.cookies.get("ebay_oauth_state")?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    settingsUrl.searchParams.set("ebay", "error");
    const res = NextResponse.redirect(settingsUrl);
    res.cookies.delete("ebay_oauth_state");
    return res;
  }

  try {
    const tokens = await exchangeCodeForToken(code);
    const environment = getEbayEnvironment();
    await prisma.ebayAuthToken.upsert({
      where: { environment },
      create: {
        environment,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      },
      update: {
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      },
    });
    settingsUrl.searchParams.set("ebay", "connected");
  } catch (e) {
    console.error("[ebay callback] token exchange failed", e);
    settingsUrl.searchParams.set("ebay", "error");
  }

  const res = NextResponse.redirect(settingsUrl);
  res.cookies.delete("ebay_oauth_state");
  return res;
}
