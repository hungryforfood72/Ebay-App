import type { MetadataRoute } from "next";

// Makes the app installable to the home screen of the Wasp Android scanner
// handheld (and any phone) — opens full-screen with no browser chrome.
// Served at /manifest.webmanifest, which proxy.ts deliberately leaves
// ungated (browsers fetch it without cookies). No service worker: Chrome
// no longer requires one for installability, and offline caching of live
// inventory/stock data has real stale-data risks not worth taking on here.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "eBay Listing Tool",
    short_name: "eBay Tool",
    description: "Scan, list, and manage liquidation inventory on eBay",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fafafa",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
