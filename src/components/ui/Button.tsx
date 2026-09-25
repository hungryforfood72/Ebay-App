import type { ComponentProps } from "react";
import { cn } from "./cn";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger"
  | "danger-ghost"
  | "success"
  | "warning";
export type ButtonSize = "sm" | "md" | "lg" | "xl" | "icon-xl";

// [&_svg]:shrink-0 — confirmed live: without it, a label that barely fits
// makes flexbox squeeze the icon down to a speck instead.
const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors [&_svg]:shrink-0 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover",
  secondary: "bg-muted text-foreground hover:bg-zinc-200",
  outline: "border border-border bg-surface text-foreground shadow-sm hover:bg-muted",
  ghost: "text-foreground hover:bg-muted",
  danger: "bg-danger text-white shadow-sm hover:bg-red-700",
  // Low-emphasis destructive action (stop promoting, finish session) —
  // its own variant rather than ghost + color overrides, since cn() doesn't
  // merge conflicting classes.
  "danger-ghost": "text-danger hover:bg-red-50",
  success: "bg-success text-white shadow-sm hover:bg-green-700",
  warning: "bg-amber-600 text-white shadow-sm hover:bg-amber-700",
};

// xl is for the scan flow's primary actions — used one-handed on the
// handheld scanner, so the main tap target should be hard to miss.
// icon-xl is a square xl for icon-only buttons (the camera button next to
// a scan field).
const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
  xl: "h-14 px-6 text-base",
  "icon-xl": "size-14",
};

// Exported so a Next <Link> can look exactly like a button without a
// polymorphic `as` prop: <Link className={buttonClasses({...})} />.
export function buttonClasses({
  variant = "primary",
  size = "md",
  block = false,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}) {
  return cn(base, variants[variant], sizes[size], block && "w-full", className);
}

export function Button({
  variant,
  size,
  block,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize; block?: boolean }) {
  return <button type={type} className={buttonClasses({ variant, size, block, className })} {...props} />;
}
