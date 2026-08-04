import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, hashPassword } from "@/lib/auth";

// Shared-password gate for the whole site, since it holds inventory photos
// and pricing. Lets everything through if a valid site_auth cookie is
// present, otherwise redirects to /login. Fails closed if SITE_PASSWORD
// isn't set (nothing will match, so login can never succeed).
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/login") || pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(AUTH_COOKIE_NAME)?.value;
  const expected = await hashPassword(process.env.SITE_PASSWORD ?? "");

  if (cookie && cookie === expected) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
