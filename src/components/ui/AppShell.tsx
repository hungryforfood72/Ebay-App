"use client";

import {
  Archive,
  ChevronDown,
  ChartColumn,
  ClipboardCheck,
  Ellipsis,
  FileSpreadsheet,
  History,
  House,
  LogOut,
  Menu,
  Monitor,
  Package,
  PackageCheck,
  PackageX,
  ScanBarcode,
  Settings,
  SplitSquareHorizontal,
  Target,
  Timer,
  Truck,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { logout, useCurrentUser } from "@/components/UserNav";
import { cn } from "./cn";

type NavItem = { href: string; label: string; icon: LucideIcon; ownerOnly?: boolean; warehouseOnly?: boolean };
type NavGroup = { label: string; items: NavItem[] };
// A top-level entry is a link or a dropdown group.
type NavEntry = NavItem | NavGroup;

function isGroup(e: NavEntry): e is NavGroup {
  return "items" in e;
}

// Single source of truth for app navigation. Every page used to hand-build
// its own row of <Link>s (which is what overflowed the scanner's screen);
// this replaces all of them. With warehouse mode the flat row grew to 15
// links and crammed the desktop header, so pages are grouped by job: the
// everyday three stay top level, the rest sit in dropdowns (desktop) or
// labelled sections (phone menu).
const NAV: NavEntry[] = [
  { href: "/", label: "Dashboard", icon: House },
  // The page is /scan for old bookmarks, the handheld's home-screen icon
  // and the relist/return links; it's called "List" because with warehouse
  // mode every station scans, and this is the one that lists things.
  { href: "/scan", label: "List", icon: ScanBarcode },
  { href: "/review", label: "Review", icon: ClipboardCheck },
  {
    // Warehouse mode pages (src/lib/warehouse), hidden until it's turned on
    // in Settings. In floor order: sort, bin, pick, then the side jobs.
    label: "Warehouse",
    items: [
      { href: "/sort", label: "Sort", icon: SplitSquareHorizontal, warehouseOnly: true },
      { href: "/bins", label: "Bins", icon: Archive, warehouseOnly: true },
      { href: "/ship", label: "Pick orders", icon: PackageCheck, warehouseOnly: true },
      // Epic Steals local delivery runs; any signed-in user can drive.
      { href: "/deliveries", label: "Deliveries", icon: Truck },
      { href: "/returns", label: "Returns", icon: Undo2, warehouseOnly: true },
      { href: "/duds", label: "Duds", icon: PackageX, warehouseOnly: true },
      { href: "/station", label: "Station", icon: Monitor, warehouseOnly: true },
    ],
  },
  {
    label: "Stock",
    items: [
      { href: "/manifests", label: "Manifests", icon: FileSpreadsheet },
      { href: "/inventory", label: "Inventory", icon: Package },
    ],
  },
  {
    // Owner-only, same as proxy.ts's ownerOnlyPrefixes — employees get
    // redirected away from /analyzer anyway, so don't dangle a dead link.
    label: "Insights",
    items: [
      { href: "/analyzer", label: "Analyzer", icon: ChartColumn, ownerOnly: true },
      { href: "/reports/scan-speed", label: "Scan speed", icon: Timer, ownerOnly: true },
      { href: "/reports/analyzer-accuracy", label: "Analyzer accuracy", icon: Target, ownerOnly: true },
      { href: "/activity", label: "Activity log", icon: History, ownerOnly: true },
    ],
  },
];
const SETTINGS: NavItem = { href: "/settings", label: "Settings", icon: Settings, ownerOnly: true };

// The phone-width bottom bar fits four destinations plus "More" — the rest
// live in the More sheet, under the same group headings as the desktop menus.
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
  const [warehouseMode, setWarehouseMode] = useState(false);
  useEffect(() => {
    fetch("/api/warehouse/mode")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setWarehouseMode(d?.on === true))
      .catch(() => setWarehouseMode(false));
  }, []);

  const canSee = (n: NavItem) => (!n.ownerOnly || isOwner) && (!n.warehouseOnly || warehouseMode);
  // Groups with nothing visible (Warehouse with the mode off, Insights for
  // an employee) disappear entirely.
  const visibleNav: NavEntry[] = NAV.flatMap((e): NavEntry[] => {
    if (!isGroup(e)) return canSee(e) ? [e] : [];
    const items = e.items.filter(canSee);
    return items.length > 0 ? [{ ...e, items }] : [];
  });
  const allLinks = visibleNav.flatMap((e) => (isGroup(e) ? e.items : [e]));
  const tabs = allLinks.filter((n) => TAB_HREFS.includes(n.href));
  // Phone menu sections: loose top-level links first (untitled), then each
  // group under its heading, then the account bits. In focused mode there's
  // no tab bar, so everything is listed; otherwise only what the tabs can't fit.
  const sheetSections = (all: boolean): { label: string | null; items: NavItem[] }[] => {
    const keep = (n: NavItem) => all || !TAB_HREFS.includes(n.href);
    const loose = visibleNav.filter((e): e is NavItem => !isGroup(e)).filter(keep);
    const groups = visibleNav
      .filter(isGroup)
      .map((g) => ({ label: g.label, items: g.items.filter(keep) }))
      .filter((g) => g.items.length > 0);
    return [
      ...(loose.length > 0 ? [{ label: null, items: loose }] : []),
      ...groups,
      ...(isOwner ? [{ label: "Account", items: [SETTINGS] }] : []),
    ];
  };
  const moreActive = sheetSections(false).some((sec) => sec.items.some((n) => isActive(pathname, n.href)));

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
            {visibleNav.map((entry) =>
              isGroup(entry) ? (
                <NavDropdown
                  key={entry.label}
                  label={entry.label}
                  active={entry.items.some((n) => isActive(pathname, n.href))}
                >
                  {entry.items.map((item) => (
                    <DropdownLink key={item.href} item={item} active={isActive(pathname, item.href)} />
                  ))}
                </NavDropdown>
              ) : (
                <Link
                  key={entry.href}
                  href={entry.href}
                  aria-current={isActive(pathname, entry.href) ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive(pathname, entry.href)
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {entry.label}
                </Link>
              )
            )}
          </nav>

          {user && (
            <div className="ml-auto hidden lg:block">
              {/* Settings and Sign out tucked under the name, so the bar
                  only carries places people go to work. */}
              <NavDropdown label={user.username} align="right" active={isActive(pathname, SETTINGS.href)}>
                <div className="px-3 pb-1.5 pt-1 text-xs capitalize text-muted-foreground">{user.role}</div>
                {isOwner && <DropdownLink item={SETTINGS} active={isActive(pathname, SETTINGS.href)} />}
                <button
                  type="button"
                  onClick={logout}
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-danger hover:bg-red-50"
                >
                  <LogOut className="size-4" aria-hidden />
                  Sign out
                </button>
              </NavDropdown>
            </div>
          )}

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
            className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-surface px-4 pt-3 shadow-2xl"
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
            <div className="flex flex-col gap-3">
              {sheetSections(focused).map((section) => (
                <div key={section.label ?? "main"}>
                  {section.label && (
                    <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {section.label}
                    </p>
                  )}
                  <ul className="flex flex-col gap-0.5">
                    {section.items.map((item) => {
                      const active = isActive(pathname, item.href);
                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            onClick={() => setSheetOpen(false)}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "flex h-11 items-center gap-3 rounded-lg px-3 text-base font-medium transition-colors",
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
                </div>
              ))}
            </div>
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

// A desktop header menu: click to open, closes on a pick, a click outside,
// Escape, or moving to another page. Highlighted when you're on one of its
// pages, so you can still tell where you are with the menu closed.
function NavDropdown({
  label,
  active,
  align = "left",
  children,
}: {
  label: string;
  active: boolean;
  align?: "left" | "right";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
          active || open ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        {label}
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          onClick={(e) => {
            // A pick inside (a link or Sign out) closes the menu.
            if ((e.target as HTMLElement).closest("a,button")) setOpen(false);
          }}
          className={cn(
            "absolute top-full z-40 mt-1.5 min-w-52 rounded-xl border border-border bg-surface p-1.5 shadow-lg",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function DropdownLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      role="menuitem"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
        active ? "bg-blue-50 text-primary" : "text-foreground hover:bg-muted"
      )}
    >
      <item.icon className="size-4 text-muted-foreground" aria-hidden />
      {item.label}
    </Link>
  );
}
