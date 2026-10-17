import { ownerOnly } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getLocation,
  getPublications,
  getShopInfo,
  getShopifyConfig,
  listWebhooks,
  missingShopifyEnvVars,
  missingShopifyScopes,
  SHOPIFY_WEBHOOK_TOPICS,
} from "@/lib/shopify";
import { getShopifyPricing, shopifyCounts } from "@/lib/shopifySync";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

// Everything the Settings page's Shopify card shows. Each part is read on
// its own so one failing (a missing scope, say) still shows the rest.
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;

  const pricing = await getShopifyPricing();
  if (!getShopifyConfig()) {
    return NextResponse.json({ configured: false, missingEnvVars: missingShopifyEnvVars(), pricing });
  }

  const webhookUrl = `${request.nextUrl.origin}/api/shopify/webhook`;
  const [shop, location, channels, webhooks, counts, recentErrors] = await Promise.all([
    settle(getShopInfo()),
    settle(getLocation()),
    settle(getPublications()),
    settle(listWebhooks()),
    shopifyCounts(),
    prisma.item.findMany({
      where: { shopifyError: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { id: true, finalTitle: true, shopifyError: true },
    }),
  ]);

  return NextResponse.json({
    configured: true,
    pricing,
    shop: shop.value ? { name: shop.value.name, domain: shop.value.domain } : null,
    missingScopes: shop.value ? missingShopifyScopes(shop.value.grantedScopes) : [],
    location: location.value,
    channels: channels.value?.map((c) => c.name) ?? null,
    webhookUrl,
    missingWebhooks: webhooks.value
      ? SHOPIFY_WEBHOOK_TOPICS.filter((t) => !webhooks.value!.some((w) => w.topic === t && w.uri === webhookUrl))
      : null,
    counts,
    recentErrors,
    errors: [shop.error, location.error, channels.error, webhooks.error].filter(Boolean),
  });
}

async function settle<T>(p: Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await p, error: null };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) };
  }
}
