import { requireUser } from "@/lib/auth";
import { counterSaleError, createCounterSale } from "@/lib/counterSale";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

// A walk-up or shelf sale from the scan page (see src/lib/counterSale.ts):
// { target: { kind, manifestId, itemId, upc, binCode }, quantity,
//   pricePerUnit, nearExpiry, photoUrls, reason, payment: "cash" | "invoice",
//   email }
// -> 201 the CounterSale. Cash is sold right away; an invoice comes back
// awaiting_payment (poll GET /api/counter-sales/{id}).
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = await request.json().catch(() => ({}));
    const t = body.target ?? {};
    const sale = await createCounterSale(
      {
        target: {
          kind: t.kind === "shelf" ? "shelf" : "walkup",
          manifestId: typeof t.manifestId === "string" && t.manifestId ? t.manifestId : null,
          itemId: typeof t.itemId === "string" && t.itemId ? t.itemId : null,
          upc: String(t.upc ?? ""),
          binCode: typeof t.binCode === "string" ? t.binCode : null,
        },
        quantity: Number(body.quantity),
        pricePerUnit: Number(body.pricePerUnit),
        nearExpiry: body.nearExpiry === true,
        photoUrls: Array.isArray(body.photoUrls) ? body.photoUrls : [],
        reason: typeof body.reason === "string" ? body.reason : null,
        payment: body.payment === "invoice" ? "invoice" : "cash",
        email: typeof body.email === "string" ? body.email : null,
      },
      user.username
    );
    return NextResponse.json(sale, { status: 201 });
  } catch (e) {
    return counterSaleError(e);
  }
}
