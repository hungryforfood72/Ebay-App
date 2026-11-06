import { logActivity } from "@/lib/activityLog";
import { ownerOnly } from "@/lib/auth";
import { getWhatnotStartPrice, setWhatnotStartPrice } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

// The starting price a new Whatnot-only listing gets (Cristian,
// 2026-11-04). Owner only. Listings already saved keep theirs; Review can
// change any one.
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  return NextResponse.json({ price: await getWhatnotStartPrice() });
}

export async function PUT(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) ?? {};
  const price = Math.round(Number(body.price) * 100) / 100;
  // Capped at $50 so a typo (100 for 1.00) can't start every new listing
  // high.
  if (!Number.isFinite(price) || price < 0.01 || price > 50) {
    return NextResponse.json({ error: "Enter a starting price between $0.01 and $50." }, { status: 400 });
  }
  const before = await getWhatnotStartPrice();
  await setWhatnotStartPrice(price);
  const after = await getWhatnotStartPrice();
  await logActivity(
    { request },
    {
      action: "setting",
      summary: `Whatnot starting price: $${before} -> $${after}`,
      targetType: "setting",
      targetId: "whatnot-start",
      before: { price: before },
      after: { price: after },
    }
  );
  return NextResponse.json({ price: after });
}
