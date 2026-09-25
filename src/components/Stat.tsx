import { cn } from "./ui/cn";

export function Stat({
  label,
  value,
  highlight,
  format,
  hint,
}: {
  label: string;
  // A string is shown as-is (already formatted, e.g. "2m 14s").
  value: number | string;
  highlight?: boolean;
  format?: "currency";
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface p-3 shadow-sm sm:p-4">
      <p className="text-xs font-medium leading-tight text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tracking-tight tabular-nums",
          highlight ? "text-danger" : "text-foreground"
        )}
      >
        {format === "currency" && typeof value === "number" ? `$${value.toFixed(2)}` : value}
      </p>
      {hint && <p className="mt-0.5 text-xs leading-tight text-muted-foreground">{hint}</p>}
    </div>
  );
}
