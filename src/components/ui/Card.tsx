import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export function Card({
  padded = true,
  className,
  ...props
}: ComponentProps<"div"> & { padded?: boolean }) {
  return (
    <div
      className={cn("rounded-xl border border-border bg-surface shadow-sm", padded && "p-4 sm:p-5", className)}
      {...props}
    />
  );
}

// Section heading used inside or above cards — title + optional one-line
// description + optional right-aligned action (a button, a count badge).
export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
