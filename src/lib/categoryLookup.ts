import { prisma } from "@/lib/prisma";
import { anthropic } from "@/lib/anthropic";

export type CategoryLookupResult = {
  categoryId: string | null;
  categoryName: string | null;
  sourceUrl: string | null;
  fromExistingRule: boolean;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "your", "pack",
  "unit", "units", "item", "new", "used", "single", "best", "premium",
]);

function significantWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return Array.from(new Set(words)).slice(0, 12);
}

// Finds an eBay category for the item and applies it. Order of preference:
// 1. A saved CategoryRule keyword match (instant, free — something we've
//    picked before).
// 2. Local search over eBay's own full category tree (imported from their
//    official export — see references/ebay-category-ids.md) + a quick,
//    tool-free Claude call to pick the best match from real candidates.
//    Fast and reliable since there's no web search involved.
// 3. AI web search, only as a last resort if step 2 finds nothing to work
//    with (e.g. a very generic or unusual title).
export async function lookupCategoryForItem(
  itemId: string
): Promise<CategoryLookupResult> {
  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  const productDescription = item.finalTitle ?? item.aiTitle ?? `UPC ${item.upc}`;
  const titleLower = productDescription.toLowerCase();

  const rules = await prisma.categoryRule.findMany();
  const existingRule = rules.find((r) => titleLower.includes(r.keyword));
  if (existingRule) {
    await prisma.item.update({
      where: { id: itemId },
      data: { categoryId: existingRule.categoryId },
    });
    return {
      categoryId: existingRule.categoryId,
      categoryName: existingRule.categoryName,
      sourceUrl: null,
      fromExistingRule: true,
    };
  }

  const words = significantWords(productDescription);
  const candidates =
    words.length > 0
      ? await prisma.ebayCategory.findMany({
          where: { OR: words.map((w) => ({ name: { contains: w, mode: "insensitive" as const } })) },
          take: 40,
        })
      : [];

  console.log(
    `[categoryLookup] ${itemId}: title="${productDescription}", words=${JSON.stringify(words)}, local candidates=${candidates.length}`
  );

  if (candidates.length > 0) {
    const pickStart = Date.now();
    const picked = await pickBestLocalCategory(productDescription, candidates);
    console.log(
      `[categoryLookup] ${itemId}: local pick took ${Date.now() - pickStart}ms, result=${JSON.stringify(picked)}`
    );
    if (picked) {
      await applyCategory(itemId, picked.categoryId, picked.categoryName, picked.keyword);
      return {
        categoryId: picked.categoryId,
        categoryName: picked.categoryName,
        sourceUrl: null,
        fromExistingRule: false,
      };
    }
  }

  return searchWebForCategory(itemId, productDescription);
}

// Fast, tool-free Claude call: pick the best match from real local
// candidates, or say none fit. No web search, so no timeout risk.
async function pickBestLocalCategory(
  productDescription: string,
  candidates: { id: string; name: string; path: string }[]
): Promise<{ categoryId: string; categoryName: string; keyword: string } | null> {
  const schema = {
    type: "object",
    properties: {
      categoryId: {
        type: ["string", "null"],
        description: "The id of the best-matching category from the candidate list, or null if none genuinely fit",
      },
      keyword: {
        type: ["string", "null"],
        description: "A short (1-3 word) reusable keyword for this product type, e.g. 'hair dye', or null if categoryId is null",
      },
    },
    required: ["categoryId", "keyword"],
    additionalProperties: false,
  } as const;

  const candidateList = candidates
    .map((c) => `${c.id}: ${c.path}`)
    .join("\n");

  let response;
  try {
    response = await anthropic.messages.create(
      {
        model: "claude-opus-4-8",
        max_tokens: 512,
        output_config: { format: { type: "json_schema", schema } },
        messages: [
          {
            role: "user",
            content: `Product: "${productDescription}"

Pick the single best-matching eBay category for this product from the candidates below (id: full path). Prefer the most specific matching category over a broad parent. If none of them genuinely fit this product, return null.

${candidateList}`,
          },
        ],
      },
      { timeout: 20_000 }
    );
  } catch (e) {
    console.error(`[categoryLookup] local-pick call failed`, e);
    return null;
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(
    textBlock && "text" in textBlock ? textBlock.text : "{}"
  ) as { categoryId?: string | null; keyword?: string | null };

  if (!parsed.categoryId) return null;
  const match = candidates.find((c) => c.id === parsed.categoryId);
  if (!match) return null;

  return { categoryId: match.id, categoryName: match.name, keyword: parsed.keyword ?? match.name.toLowerCase() };
}

async function applyCategory(
  itemId: string,
  categoryId: string,
  categoryName: string,
  keyword: string
) {
  await prisma.item.update({ where: { id: itemId }, data: { categoryId } });
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (normalizedKeyword) {
    await prisma.categoryRule.upsert({
      where: { keyword: normalizedKeyword },
      create: { keyword: normalizedKeyword, categoryId, categoryName },
      update: { categoryId, categoryName },
    });
  }
}

// Last resort — only reached if the local category tree search above found
// nothing usable. Same web-search approach as before, same timeout caution.
async function searchWebForCategory(
  itemId: string,
  productDescription: string
): Promise<CategoryLookupResult> {
  console.log(`[categoryLookup] ${itemId}: no local match, falling back to web search`);

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
      { timeout: 35_000 }
    );
  } catch (e) {
    console.error(`[categoryLookup] ${itemId}: web search call failed/timed out`, e);
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

  await applyCategory(itemId, parsed.categoryId, parsed.categoryName ?? parsed.categoryId, parsed.keyword ?? "");

  return {
    categoryId: parsed.categoryId,
    categoryName: parsed.categoryName,
    sourceUrl: parsed.sourceUrl,
    fromExistingRule: false,
  };
}
