import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "eBay Listing Tool",
  description: "Internal Sticker Peak tool for scanning and listing inventory to eBay",
  // Installed-app title on Android's home screen/task switcher when opened
  // standalone from the PWA icon (see app/manifest.ts).
  applicationName: "eBay Tool",
};

// viewportFit: "cover" lets the fixed bottom tab bar (see AppShell) extend
// under a device's gesture/nav area and pad itself with safe-area insets,
// rather than leaving a gap. Zoom deliberately left enabled — disabling it
// is an accessibility anti-pattern, and nothing here needs it off. Light
// only for now — see the comment at the top of globals.css.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
