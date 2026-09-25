import { cn } from "./ui/cn";

export function Stat({
  label,
  value,
  highlight,
  format,
}: {
  label: string;
  value: number;
  highlight?: boolean;
  format?: "currency";
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface p-3 shadow-sm sm:p-4">
      <p className="text-xs font-medium leading-tight text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular-nums", highlight ? "text-danger" : "text-foreground")}>
        {format === "currency" ? `$${value.toFixed(2)}` : value}
      </p>
    </div>
  );
}
