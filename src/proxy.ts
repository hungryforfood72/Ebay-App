import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import { logRequest } from "@/lib/activityLog";
import { AUTH_COOKIE_NAME, getUserForSessionToken } from "@/lib/auth";

// Header names proxy.ts attaches after verifying a session — routes/pages
// read these instead of re-deriving the session themselves. Always SET
// explicitly below (never passed through from the incoming request), so a
// client can't spoof its own role by just sending these headers directly —
// whatever the client sent gets overwritten with the server-verified
// value (or stripped entirely when there's no valid session).
export const USER_ID_HEADER = "x-user-id";
export const USER_ROLE_HEADER = "x-user-role";
export const USERNAME_HEADER = "x-username";

const PUBLIC_WEBHOOK_PATHS = ["/api/shopify/webhook", "/api/ebay/notifications", "/api/ebay/account-deletion"];

// Public pages anyone can open signed-out: the landing page and the privacy
// policy eBay's API License requires. Exact paths only.
const PUBLIC_PAGES = ["/about", "/privacy"];

// A consignment supplier's read-only report (src/lib/supplierShare.ts):
// exactly /s/{token} and /api/share/{token}, with a token shaped like
// newShareToken's (32 URL-safe characters). Exact patterns, not prefixes,
// so no other page or API can ever be reached signed-out through them.
const SHARE_PATHS = [/^\/s\/[A-Za-z0-9_-]{32}$/, /^\/api\/share\/[A-Za-z0-9_-]{32}$/];

// Per-user session gate for the whole site, since it holds inventory
// photos, pricing, and (for the owner) financial data. Next.js 16 runs
// proxy.ts on the Node.js runtime by default (confirmed against the
// bundled docs before relying on it) — a real Prisma session lookup here
// is cheap and simple, unlike the stateless signed-cookie scheme an edge
// runtime would have forced.
export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const { pathname } = request.nextUrl;

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const user = await getUserForSessionToken(token);

  if (!user) {
    // /login itself, /api/auth (login/logout — by definition called with no
    // session yet), and /api/cron/* (carries Vercel's own Authorization:
    // Bearer $CRON_SECRET header instead, verified by the route itself) are
    // the only places allowed to proceed signed-out. Scoped to the !user
    // branch only — an *authenticated* request to /api/auth (e.g. the
    // client's "who am I" check) still needs to fall through below and get
    // its headers attached, or getRequestUser() would never see who's
    // signed in.
    if (pathname.startsWith("/login") || pathname.startsWith("/api/auth") || pathname.startsWith("/api/cron")) {
      return NextResponse.next();
    }
    // Shopify's order webhooks and eBay's sale alerts: each route checks
    // the sender's own signature instead. Exact paths only, so nothing
    // under them (like the alert setup route) slips through signed-out.
    if (PUBLIC_WEBHOOK_PATHS.includes(pathname)) {
      return NextResponse.next();
    }
    if (PUBLIC_PAGES.includes(pathname)) {
      return NextResponse.next();
    }
    // The site's front door: signed-out visitors get the landing page at
    // the bare address (staff are sent to the dashboard as before).
    if (pathname === "/") {
      return NextResponse.rewrite(new URL("/about", request.url));
    }
    // The Shopify app proxy (the store's /apps/deals/*, deal alerts): the
    // route checks Shopify's signature on every request.
    if (pathname.startsWith("/api/shopify-proxy/")) {
      return NextResponse.next();
    }
    // The supplier's report: the random token in the URL is the only key,
    // checked against the database by the route.
    if (SHARE_PATHS.some((p) => p.test(pathname))) {
      // Same rule as everywhere: identity headers are only ever set by
      // this file, never passed through from the visitor.
      const headers = new Headers(request.headers);
      headers.delete(USER_ID_HEADER);
      headers.delete(USER_ROLE_HEADER);
      headers.delete(USERNAME_HEADER);
      return NextResponse.next({ request: { headers } });
    }
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Owner-only surfaces, blocked here as well as at the API layer
  // (defense in depth — the Route Handler docs themselves warn not to
  // rely on proxy alone: a matcher change elsewhere could silently drop
  // coverage). /settings and the user-management API are hard-blocked
  // because there's no partial view of them; financial-field filtering on
  // shared pages (dashboard, manifests, etc.) happens in each route
  // handler instead, since those pages are visible to employees too, just
  // with numbers omitted. /analyzer is also hard-blocked rather than
  // field-filtered like Manifests — it's purely a pre-purchase bid-decision
  // tool (buy/don't-buy, max bid — Cristian's explicit "bid decisions"
  // restriction) with no receiving/listing work underneath it, and its
  // page component assumes those numbers are always present, so a
  // stripped response there would crash the page rather than just show
  // fewer numbers.
  const ownerOnlyPrefixes = ["/settings", "/api/users", "/analyzer", "/reports", "/api/reports", "/activity", "/api/activity"];
  if (user.role !== "owner" && ownerOnlyPrefixes.some((p) => pathname.startsWith(p))) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Owner access required." }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Activity log (src/lib/activityLog.ts): every data-changing API call,
  // with who made it. A copy of the request is read after the response is
  // sent, so it costs the request nothing and the route still gets the body.
  if (request.method !== "GET" && request.method !== "HEAD" && pathname.startsWith("/api/")) {
    event.waitUntil(logRequest(request.clone(), user));
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(USER_ID_HEADER, user.id);
  requestHeaders.set(USER_ROLE_HEADER, user.role);
  requestHeaders.set(USERNAME_HEADER, user.username);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// manifest.webmanifest and public/icons/ are excluded so the app is
// actually installable as a PWA: browsers fetch the web manifest WITHOUT
// cookies by default (credentials: "omit" per the manifest spec), so with
// these gated behind the session check above, the install check would get
// redirected to /login's HTML instead of the manifest JSON and silently
// fail. Neither contains anything sensitive — just the app name and a
// generic icon.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/).*)"],
};
