import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

// 16px (text-base) on purpose, not text-sm: Android Chrome and iOS Safari
// both zoom the page in when focusing an input with a smaller font size,
// which on the scanner handheld would shift the whole wizard sideways on
// every scan-and-Enter step.
// Font size lives in inputHeights / the textarea class rather than here, so
// a size never has two conflicting text-* classes (cn() doesn't merge).
const inputBase =
  "block w-full rounded-lg border border-border bg-surface px-3 text-foreground shadow-sm " +
  "placeholder:text-zinc-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const inputHeights = { sm: "h-10 text-base", md: "h-11 text-base", lg: "h-14 text-lg" } as const;

export function Input({
  size = "md",
  className,
  ...props
}: Omit<ComponentProps<"input">, "size"> & { size?: keyof typeof inputHeights }) {
  return <input className={cn(inputBase, inputHeights[size], className)} {...props} />;
}

export function Select({
  size = "md",
  className,
  ...props
}: Omit<ComponentProps<"select">, "size"> & { size?: "sm" | "md" }) {
  return <select className={cn(inputBase, inputHeights[size], "pr-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(inputBase, "py-2 text-base", className)} {...props} />;
}

// Label + optional hint above a field. Wraps children in a <label> so a
// tap on the label text focuses the input (a bigger target on a small
// touchscreen). Pass htmlFor (and a matching id on the input) when the
// field also contains a button — e.g. a scan field's camera button — since
// a <label> may only contain one labelable element.
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const labelText = "mb-1.5 block text-sm font-medium text-foreground";
  const hintEl = hint && <span className="mt-1.5 block text-xs text-muted-foreground">{hint}</span>;
  if (htmlFor) {
    return (
      <div className={className}>
        <label htmlFor={htmlFor} className={labelText}>
          {label}
        </label>
        {children}
        {hintEl}
      </div>
    );
  }
  return (
    <label className={cn("block", className)}>
      <span className={labelText}>{label}</span>
      {children}
      {hintEl}
    </label>
  );
}

// Checkbox row with a generous tap area — plain checkboxes are tiny targets
// on the scanner's touchscreen.
export function CheckboxRow({
  label,
  description,
  className,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-3 text-sm shadow-sm has-[:checked]:border-primary has-[:checked]:bg-blue-50/60",
        className
      )}
    >
      <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]" {...props} />
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{label}</span>
        {description && <span className="mt-0.5 block text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}
