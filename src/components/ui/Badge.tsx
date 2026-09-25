import type { ComponentProps } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "purple";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-muted text-zinc-700 ring-zinc-500/15",
  primary: "bg-blue-50 text-blue-700 ring-blue-600/20",
  success: "bg-green-50 text-green-700 ring-green-600/20",
  warning: "bg-amber-50 text-amber-800 ring-amber-600/25",
  danger: "bg-red-50 text-red-700 ring-red-600/20",
  purple: "bg-purple-50 text-purple-700 ring-purple-600/20",
};

export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}
