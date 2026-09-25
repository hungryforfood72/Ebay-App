import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type AlertTone = "info" | "warning" | "danger" | "success";

const tones: Record<AlertTone, { box: string; icon: LucideIcon; iconColor: string }> = {
  info: { box: "border-blue-200 bg-blue-50 text-blue-950", icon: Info, iconColor: "text-blue-600" },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-950", icon: TriangleAlert, iconColor: "text-amber-600" },
  danger: { box: "border-red-200 bg-red-50 text-red-950", icon: CircleAlert, iconColor: "text-red-600" },
  success: { box: "border-green-200 bg-green-50 text-green-950", icon: CircleCheck, iconColor: "text-green-600" },
};

// Status callout — replaces the ad-hoc amber/orange/red banner divs each
// page used to hand-roll for warnings like "eBay not connected" or
// "expired, needs shelf pull".
export function Alert({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon, iconColor } = tones[tone];
  return (
    <div className={cn("flex gap-3 rounded-xl border p-4 text-sm", box, className)} role={tone === "danger" ? "alert" : undefined}>
      <Icon className={cn("mt-0.5 size-5 shrink-0", iconColor)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title ? "mt-1" : undefined, "leading-relaxed")}>{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
