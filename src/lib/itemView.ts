import { getRequestUser } from "@/lib/auth";

// Employees see no sales money and no units sold (Cristian's rule), but Item
// rows carry both. Every route that hands an item (or a stock-count result)
// to the browser passes it through here.
//
// For employees, quantity becomes the units left and soldQuantity 0, so the
// pages' own "quantity - soldQuantity" math still comes out to units left.
// Quantity changes are sent as a direction + amount, never a total, so the
// rewritten number is never written back.
const SALES_MONEY_FIELDS = ["soldRevenueTotal", "soldFeesTotal", "soldShippingTotal", "refundedTotal"];

function hideSales(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const field of SALES_MONEY_FIELDS) delete out[field];
  if (typeof out.quantity === "number" && typeof out.soldQuantity === "number") {
    out.quantity = Math.max(0, out.quantity - out.soldQuantity);
    out.soldQuantity = 0;
  } else if ("soldQuantity" in out) {
    out.soldQuantity = 0;
  }
  return out;
}

export function forViewer<T>(request: Request, value: T): T {
  if (getRequestUser(request)?.role === "owner") return value;
  if (Array.isArray(value)) {
    return value.map((v) => (v && typeof v === "object" ? hideSales(v as Record<string, unknown>) : v)) as T;
  }
  if (value && typeof value === "object") return hideSales(value as Record<string, unknown>) as T;
  return value;
}
