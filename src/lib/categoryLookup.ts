import { prisma } from "@/lib/prisma";
import { anthropic } from "@/lib/anthropic";

export type CategoryLookupResult = {
  categoryId: string | null;
  categoryName: string | null;
  sourceUrl: string | null;
  fromExistingRule: boolean;
};

// Finds an eBay category for the item and applies it, preferring a saved
// CategoryRule (instant, free) over an AI web search (slow, costs money).
// When a fresh AI search finds one, it's saved as a new rule automatically
// so the same product type never needs searching again.
export async function lookupCategoryForItem(
  itemId: string
): Promise<CategoryLookupResult> {
  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  const productDescription = item.finalTitle ?? item.aiTitle ?? `UPC ${item.upc}`;
  const titleLower = productDescription.toLowerCase();

  console.log(`[categoryLookup] ${itemId}: starting, title="${productDescription}"`);

  const rules = await prisma.categoryRule.findMany();
  const existingRule = rules.find((r) => titleLower.includes(r.keyword));
  if (existingRule) {
    await prisma.item.update({
      where: { id: itemId },
      data: { categoryId: existingRule.categoryId },
    });
    console.log(
      `[categoryLookup] ${itemId}: matched existing rule "${existingRule.keyword}" -> ${existingRule.categoryId}`
    );
    return {
      categoryId: existingRule.categoryId,
      categoryName: existingRule.categoryName,
      sourceUrl: null,
      fromExistingRule: true,
    };
  }

  console.log(`[categoryLookup] ${itemId}: no existing rule matched, calling Claude web search`);

  let response;
  try {
    response = await anthropic.messages.create(
      {
        model: "claude-opus-4-8",
        max_tokens: 1024,
        output_config: { effort: "low" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
        messages: [
          {
            role: "user",
            content: `Find the real, current eBay category ID for this product: "${productDescription}".

Search eBay's own site (ebay.com). The category ID is embedded in eBay's live browse/search URLs — either as the numeric segment in a "/b/Name/123456/bn_..." browse URL, or as "_sacat=123456" on a search results page. Pick the most specific matching category, not an overly broad parent category.

Also suggest a short, reusable keyword (1-3 words, lowercase, no brand names) that identifies this general product type — this gets saved so future items of the same type skip the search. E.g. "hair dye", "vinyl sticker", "action figure".

Once you've found it, respond with exactly one JSON object as your final line, no other text after it:
{"categoryId": "123456", "categoryName": "Category Name", "sourceUrl": "https://...", "keyword": "short keyword"}

If you can't find a confident match, respond with:
{"categoryId": null, "categoryName": null, "sourceUrl": null, "keyword": null}`,
          },
        ],
      },
      // Web search latency is unpredictable and occasionally hangs well past
      // what's reasonable. Kept well under Vercel's own function timeout so
      // *our* error handling fires first — otherwise Vercel kills the
      // request and returns its own plain-text/HTML error page instead of
      // the JSON error response below, which broke the client's res.json().
      { timeout: 35_000 }
    );
    console.log(`[categoryLookup] ${itemId}: Claude call finished`);
  } catch (e) {
    console.error(`[categoryLookup] ${itemId}: Claude call failed/timed out`, e);
    return { categoryId: null, categoryName: null, sourceUrl: null, fromExistingRule: false };
  }

  const textBlocks = response.content.filter(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text"
  );
  const lastText = textBlocks[textBlocks.length - 1]?.text ?? "";
  const match = lastText.match(/\{[\s\S]*\}\s*$/);

  let parsed: {
    categoryId: string | null;
    categoryName: string | null;
    sourceUrl: string | null;
    keyword: string | null;
  } = { categoryId: null, categoryName: null, sourceUrl: null, keyword: null };
  if (match) {
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      // Fall through with the "not found" default.
    }
  }

  if (!parsed.categoryId) {
    return { categoryId: null, categoryName: null, sourceUrl: null, fromExistingRule: false };
  }

  await prisma.item.update({
    where: { id: itemId },
    data: { categoryId: parsed.categoryId },
  });

  if (parsed.keyword) {
    const keyword = parsed.keyword.trim().toLowerCase();
    await prisma.categoryRule.upsert({
      where: { keyword },
      create: {
        keyword,
        categoryId: parsed.categoryId,
        categoryName: parsed.categoryName ?? keyword,
      },
      update: {
        categoryId: parsed.categoryId,
        categoryName: parsed.categoryName ?? keyword,
      },
    });
  }

  return {
    categoryId: parsed.categoryId,
    categoryName: parsed.categoryName,
    sourceUrl: parsed.sourceUrl,
    fromExistingRule: false,
  };
}
