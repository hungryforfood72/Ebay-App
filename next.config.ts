import type { NextConfig } from "next";

// Security headers on every response. Other sites can't frame the app
// (clickjacking on Settings, Users, Publish); same-origin is still allowed
// for the review page's eBay description preview. Device access is limited
// to what the app's own pages use: the camera (barcode scanning),
// geolocation (deliveries) and WebHID (scale).
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), geolocation=(self), hid=(self), microphone=(), usb=(), serial=(), payment=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
