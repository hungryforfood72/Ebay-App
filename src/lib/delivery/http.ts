import { NextResponse } from "next/server";
import { DeliveryError } from "./deliveries";

// One error shape for the /api/deliveries routes: a DeliveryError is the
// driver's mistake or a state the page should explain; anything else is
// Shopify or the database.
export function deliveryErrorResponse(e: unknown, label: string) {
  if (e instanceof DeliveryError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(`[deliveries] ${label}`, e);
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
}
