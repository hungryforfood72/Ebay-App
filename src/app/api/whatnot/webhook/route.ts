import { prisma } from "@/lib/prisma";
import { verifyWhatnotWebhook } from "@/lib/whatnot";
import { processWhatnotOrder, syncWhatnotStock } from "@/lib/whatnotSync";
import { after, NextRequest, NextResponse } from "next/server";

export const maxDuration = 120;

// Whatnot's webhooks (subscribed in Whatnot's developer dashboard, pointed
// here). Signed-out by design (exempted in proxy.ts); the Standard Webhooks
// signature with WHATNOT_WEBHOOK_SECRET is the gate. Whatnot wants a 2xx
// within 5 seconds and delivers at least once (same webhook-id on a retry),
// so a delivery is recorded by id first and the work runs after the
// response. Only the ids in the payload are used: the order itself is read
// back from the API.
export async function POST(request: NextRequest) {
  const secret = process.env.WHATNOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Not set up." }, { status: 503 });
  const raw = await request.text();
  const id = request.headers.get("webhook-id");
  const ok = verifyWhatnotWebhook({
    secret,
    id,
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
    rawBody: raw,
  });
  if (!ok || !id || id.length > 100) return NextResponse.json({ error: "Bad signature." }, { status: 401 });

  let event: { type?: unknown; data?: Record<string, unknown> };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Bad body." }, { status: 400 });
  }
  const type = typeof event.type === "string" ? event.type.slice(0, 100) : "unknown";

  // Already handled this delivery: say so, do nothing.
  try {
    await prisma.whatnotWebhookEvent.create({ data: { id, type } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return NextResponse.json({ ok: true, duplicate: true });
    throw e;
  }

  const data = event.data ?? {};
  after(async () => {
    try {
      if (type === "orders.created" || type === "orders.updated") {
        const orderId = typeof data.id === "string" ? data.id : null;
        if (orderId) {
          const r = await processWhatnotOrder(orderId);
          if (r.errors.length) console.error("[whatnot webhook] order errors", r.errors);
        }
      } else if (type === "products.deleted") {
        // Deleted on Whatnot by hand: a choice, not a problem. Stop
        // tracking it so it isn't put back.
        const productId = typeof data.id === "string" ? data.id : null;
        if (productId) {
          await prisma.item.updateMany({
            where: { whatnotProductId: productId, whatnotEndedAt: null },
            data: { whatnotEndedAt: new Date() },
          });
        }
      } else if (type === "products.updated") {
        const productId = typeof data.id === "string" ? data.id : null;
        const item = productId ? await prisma.item.findUnique({ where: { whatnotProductId: productId }, select: { id: true } }) : null;
        if (item) {
          const errors = await syncWhatnotStock([item.id]);
          if (errors.length) console.error("[whatnot webhook] stock errors", errors);
        }
      }
    } catch (e) {
      console.error(`[whatnot webhook] ${type} failed`, e);
    }
  });
  return NextResponse.json({ ok: true });
}
