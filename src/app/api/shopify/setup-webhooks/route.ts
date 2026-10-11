import { ownerOnly } from "@/lib/auth";
import { createWebhook, listWebhooks, SHOPIFY_WEBHOOK_TOPICS } from "@/lib/shopify";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Points Shopify's order webhooks at this app, at whatever domain Settings
// was opened on. Only adds what's missing, so it's safe to press again.
export async function POST(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const uri = `${request.nextUrl.origin}/api/shopify/webhook`;
  try {
    const existing = await listWebhooks();
    let created = 0;
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      if (existing.some((w) => w.topic === topic && w.uri === uri)) continue;
      await createWebhook(topic, uri);
      created++;
    }
    return NextResponse.json({ ok: true, created });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
