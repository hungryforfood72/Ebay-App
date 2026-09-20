import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
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

// Per-user session gate for the whole site, since it holds inventory
// photos, pricing, and (for the owner) financial data. Next.js 16 runs
// proxy.ts on the Node.js runtime by default (confirmed against the
// bundled docs before relying on it) — a real Prisma session lookup here
// is cheap and simple, unlike the stateless signed-cookie scheme an edge
// runtime would have forced.
export async function proxy(request: NextRequest) {
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
  const ownerOnlyPrefixes = ["/settings", "/api/users", "/analyzer"];
  if (user.role !== "owner" && ownerOnlyPrefixes.some((p) => pathname.startsWith(p))) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Owner access required." }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/", request.url));
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(USER_ID_HEADER, user.id);
  requestHeaders.set(USER_ROLE_HEADER, user.role);
  requestHeaders.set(USERNAME_HEADER, user.username);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
