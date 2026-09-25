"use client";

import {
  ChartColumn,
  ClipboardCheck,
  Ellipsis,
  FileSpreadsheet,
  House,
  LogOut,
  Menu,
  Package,
  ScanBarcode,
  Settings,
  Timer,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { logout, useCurrentUser } from "@/components/UserNav";
import { cn } from "./cn";

type NavItem = { href: string; label: string; icon: LucideIcon; ownerOnly?: boolean };

// Single source of truth for app navigation. Every page used to hand-build
// its own row of <Link>s (which is what overflowed the scanner's screen);
// this replaces all of them.
const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: House },
  { href: "/scan", label: "Scan", icon: ScanBarcode },
  { href: "/review", label: "Review", icon: ClipboardCheck },
  { href: "/manifests", label: "Manifests", icon: FileSpreadsheet },
  { href: "/inventory", label: "Inventory", icon: Package },
  // Owner-only, same as proxy.ts's ownerOnlyPrefixes — employees get
  // redirected away from /analyzer anyway, so don't dangle a dead link.
  { href: "/analyzer", label: "Analyzer", icon: ChartColumn, ownerOnly: true },
  { href: "/reports/scan-speed", label: "Scan speed", icon: Timer, ownerOnly: true },
];
const SETTINGS: NavItem = { href: "/settings", label: "Settings", icon: Settings, ownerOnly: true };

// The phone-width bottom bar fits four destinations plus "More" — the rest
// (inventory, analyzer, settings, sign out) live in the More sheet.
const TAB_HREFS = ["/", "/scan", "/review", "/manifests"];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export type AppShellWidth = "narrow" | "medium" | "default" | "wide";

const widths: Record<AppShellWidth, string> = {
  narrow: "max-w-lg",
  medium: "max-w-3xl",
  default: "max-w-5xl",
  wide: "max-w-6xl",
};

export function AppShell({
  title,
  subtitle,
  actions,
  width = "default",
  focused = false,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  width?: AppShellWidth;
  // Task flows with their own fixed bottom action bar (the scan wizard's
  // Back/Next) hide the bottom tab bar so the two don't stack — a menu
  // button in the header takes its place as the way to navigate out.
  focused?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const user = useCurrentUser();
  const isOwner = user?.role === "owner";
  const [sheetOpen, setSheetOpen] = useState(false);

  const visibleNav = NAV.filter((n) => !n.ownerOnly || isOwner);
  const tabs = visibleNav.filter((n) => TAB_HREFS.includes(n.href));
  const moreItems = [...visibleNav.filter((n) => !TAB_HREFS.includes(n.href)), ...(isOwner ? [SETTINGS] : [])];
  const moreActive = moreItems.some((n) => isActive(pathname, n.href));

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheetOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight text-foreground">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <ScanBarcode className="size-4.5" aria-hidden />
            </span>
            <span>eBay Tool</span>
          </Link>

          <nav className="ml-6 hidden items-center gap-1 lg:flex" aria-label="Primary">
            {visibleNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive(pathname, item.href)
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto hidden items-center gap-1 lg:flex">
            {isOwner && (
              <Link
                href={SETTINGS.href}
                title="Settings"
                aria-label="Settings"
                className={cn(
                  "grid size-9 place-items-center rounded-md transition-colors",
                  isActive(pathname, SETTINGS.href) ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Settings className="size-4.5" aria-hidden />
              </Link>
            )}
            {user && (
              <>
                <span className="px-2 text-sm text-muted-foreground">{user.username}</span>
                <button
                  type="button"
                  onClick={logout}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <LogOut className="size-4" aria-hidden />
                  Sign out
                </button>
              </>
            )}
          </div>

          {focused && (
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              aria-label="Open menu"
              className="ml-auto grid size-10 place-items-center rounded-md text-foreground hover:bg-muted lg:hidden"
            >
              <Menu className="size-5" aria-hidden />
            </button>
          )}
        </div>
      </header>

      <main className={cn("mx-auto w-full flex-1 px-4 pt-5 sm:pt-8", widths[width], focused ? "pb-10" : "pb-28 lg:pb-12")}>
        {(title || actions) && (
          <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 sm:mb-6">
            <div className="min-w-0">
              {title && <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>}
              {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        )}
        {children}
      </main>

      {!focused && (
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur lg:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <div className="mx-auto grid max-w-lg grid-cols-5">
            {tabs.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex flex-col items-center gap-1 pb-2 pt-2.5 text-[11px] font-medium transition-colors",
                    active ? "text-primary" : "text-muted-foreground active:text-foreground"
                  )}
                >
                  <item.icon className="size-5.5" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
                  {item.href === "/" ? "Home" : item.label}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className={cn(
                "flex flex-col items-center gap-1 pb-2 pt-2.5 text-[11px] font-medium transition-colors",
                moreActive ? "text-primary" : "text-muted-foreground active:text-foreground"
              )}
            >
              <Ellipsis className="size-5.5" strokeWidth={moreActive ? 2.25 : 1.75} aria-hidden />
              More
            </button>
          </div>
        </nav>
      )}

      {sheetOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-zinc-950/40"
            onClick={() => setSheetOpen(false)}
          />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-surface px-4 pt-3 shadow-2xl"
            style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300" aria-hidden />
            <div className="mb-3 flex items-center justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{user?.username ?? "Menu"}</p>
                {user && <p className="text-xs capitalize text-muted-foreground">{user.role}</p>}
              </div>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="Close menu"
                className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            {/* In focused mode there's no tab bar, so the sheet lists every
                destination; otherwise just the ones the tab bar can't fit. */}
            <ul className="flex flex-col gap-1">
              {(focused ? [...visibleNav, ...(isOwner ? [SETTINGS] : [])] : moreItems).map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setSheetOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-12 items-center gap-3 rounded-lg px-3 text-base font-medium transition-colors",
                        active ? "bg-blue-50 text-primary" : "text-foreground hover:bg-muted"
                      )}
                    >
                      <item.icon className="size-5" aria-hidden />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
            {user && (
              <div className="mt-2 border-t border-border pt-2">
                <button
                  type="button"
                  onClick={logout}
                  className="flex h-12 w-full items-center gap-3 rounded-lg px-3 text-base font-medium text-danger hover:bg-red-50"
                >
                  <LogOut className="size-5" aria-hidden />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
