import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./prisma";

// USD per million tokens, Anthropic first-party rates as of 2026-09-29.
// Update when pricing changes or a new model starts being used — a model
// missing here still gets its tokens logged, just no cost estimate.
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  // Sonnet 5 stayed at $2/$10: the $3/$15 increase planned for
  // 2026-09-01 was cancelled. Staying on it over Sonnet 5.5 (same price)
  // by choice, 2026-09-29; 5.5 is listed so a trial call is costed right.
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute cache writes
const WEB_SEARCH_PRICE_USD = 10 / 1000;

function priceFor(model: string) {
  // The API can answer with a dated model id; match on the family prefix,
  // most specific first ("claude-sonnet-5-5" before "claude-sonnet-5").
  const key = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? MODEL_PRICES[key] : null;
}

// Records one Claude call in AiUsageLog. Never throws: a logging failure
// must not fail the feature that made the call.
export async function logAiUsage(
  feature: string,
  response: Anthropic.Message,
  ref: { evaluationId?: string; itemId?: string } = {}
): Promise<void> {
  try {
    const u = response.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const webSearches = u.server_tool_use?.web_search_requests ?? 0;
    const price = priceFor(response.model);
    const estimatedCostUsd = price
      ? (u.input_tokens * price.input +
          cacheRead * price.input * CACHE_READ_MULTIPLIER +
          cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
          u.output_tokens * price.output) /
          1_000_000 +
        webSearches * WEB_SEARCH_PRICE_USD
      : null;
    await prisma.aiUsageLog.create({
      data: {
        feature,
        model: response.model,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        webSearches,
        estimatedCostUsd,
        evaluationId: ref.evaluationId,
        itemId: ref.itemId,
      },
    });
  } catch (e) {
    console.error(`[aiUsage] failed to log usage for ${feature}`, e);
  }
}
