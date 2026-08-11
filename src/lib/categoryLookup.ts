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
//    official export — see references/ebay-category-ids.md) using literal
//    words from the title/specifics + a quick, tool-free Claude call to pick
//    the best match from real candidates. Fast and reliable since there's no
//    web search involved.
// 3. If that finds nothing (common when the title is dominated by brand/
//    scent/flavor words that never appear in a category name — e.g. "Glade
//    Bergamot & Eucalyptus Automatic Spray Refill" has no literal overlap
//    with "Air Fresheners"), ask Claude for a few generic category-type
//    search terms instead, and retry the local search with those. Still no
//    web search, still fast.
// 4. AI web search, only as an absolute last resort if step 3 also finds
//    nothing to work with (e.g. a very generic or unusual title).
export async function lookupCategoryForItem(
  itemId: string
): Promise<CategoryLookupResult> {
  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  const productDescription =
    item.finalTitle ??
    item.aiTitle ??
    (item.upc ? `UPC ${item.upc}` : item.isBundle ? `bundle ${item.sku}` : `item ${item.sku}`);
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

  const specifics = (item.itemSpecifics as Record<string, string> | null) ?? {};
  // Fold in the AI-identified product type/brand — these are often more
  // category-relevant than words picked out of the title itself (e.g. a
  // title says "Automatic Spray Refill" but specifics.type says the same
  // thing more plainly, and it's a clean signal on its own).
  const searchText = [productDescription, specifics.type, specifics.brand]
    .filter(Boolean)
    .join(" ");

  const words = significantWords(searchText);
  let candidates = await findLocalCandidates(words);

  console.log(
    `[categoryLookup] ${itemId}: title="${productDescription}", words=${JSON.stringify(words)}, local candidates=${candidates.length}`
  );

  let picked = candidates.length > 0 ? await timedPick(itemId, productDescription, candidates) : null;

  if (!picked) {
    // Literal word overlap found nothing usable — ask Claude for generic
    // category-type terms (e.g. "air freshener", "home fragrance") instead
    // of brand/scent words, and try the local tree again with those.
    const genericTerms = await suggestGenericCategoryTerms(productDescription, specifics);
    console.log(`[categoryLookup] ${itemId}: generic terms=${JSON.stringify(genericTerms)}`);

    if (genericTerms.length > 0) {
      const broaderCandidates = await findLocalCandidates(genericTerms);
      // Merge with anything found in the first pass, deduped by id.
      const merged = new Map(candidates.map((c) => [c.id, c]));
      for (const c of broaderCandidates) merged.set(c.id, c);
      candidates = Array.from(merged.values());

      console.log(`[categoryLookup] ${itemId}: broadened local candidates=${candidates.length}`);
      if (candidates.length > 0) {
        picked = await timedPick(itemId, productDescription, candidates);
      }
    }
  }

  if (picked) {
    await applyCategory(itemId, picked.categoryId, picked.categoryName, picked.keyword);
    return {
      categoryId: picked.categoryId,
      categoryName: picked.categoryName,
      sourceUrl: null,
      fromExistingRule: false,
    };
  }

  return searchWebForCategory(itemId, productDescription);
}

// Pulls a generous pool of matches (no ranking from Postgres — `contains`
// gives no relevance signal), then scores and trims it ourselves. Without
// this, an unordered `take: N` on a common word like "toy" or "water" — which
// can match thousands of rows across the 20k+ category tree — returns
// whatever Postgres happens to hand back first, which is essentially random
// and can easily miss the one category that actually fits.
async function findLocalCandidates(words: string[]) {
  if (words.length === 0) return [];

  const pool = await prisma.ebayCategory.findMany({
    where: {
      OR: words.flatMap((w) => [
        { name: { contains: w, mode: "insensitive" as const } },
        { path: { contains: w, mode: "insensitive" as const } },
      ]),
    },
    take: 2000,
  });

  const scored = pool.map((c) => {
    const nameLower = c.name.toLowerCase();
    const pathLower = c.path.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (nameLower.includes(w)) score += 3;
      else if (pathLower.includes(w)) score += 1;
    }
    return { candidate: c, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break toward shorter, more specific-looking names.
    return a.candidate.name.length - b.candidate.name.length;
  });

  // A parent/umbrella category (e.g. "Candy") often outscores its own more
  // specific leaf children (e.g. "Chocolate Sweets & Assortments") because
  // the search word matches its name directly — but eBay rejects listings
  // under non-leaf categories ("category is not a leaf category" on a real
  // upload). Take a generous buffer past the final 40 before filtering, so
  // dropping parents still leaves a full leaf-only pool for the AI to pick
  // from.
  const leafCandidates = await filterToLeaves(scored.slice(0, 100).map((s) => s.candidate));
  return leafCandidates.slice(0, 40);
}

// eBay only allows listing directly under "leaf" categories (ones with no
// children) — the local tree has no explicit leaf flag, so infer it: a
// category is a leaf if no other row's path starts with its own path + " > ".
async function filterToLeaves<T extends { path: string }>(candidates: T[]): Promise<T[]> {
  if (candidates.length === 0) return candidates;

  const children = await prisma.ebayCategory.findMany({
    where: { OR: candidates.map((c) => ({ path: { startsWith: `${c.path} > ` } })) },
    select: { path: true },
  });

  return candidates.filter(
    (c) => !children.some((child) => child.path.startsWith(`${c.path} > `))
  );
}

async function timedPick(
  itemId: string,
  productDescription: string,
  candidates: { id: string; name: string; path: string }[]
) {
  const pickStart = Date.now();
  const picked = await pickBestLocalCategory(productDescription, candidates);
  console.log(
    `[categoryLookup] ${itemId}: local pick took ${Date.now() - pickStart}ms, result=${JSON.stringify(picked)}`
  );
  return picked;
}

// Cheap, fast, tool-free Claude call: given a product that literal keyword
// search couldn't place, suggest a few generic retail-category search terms
// (not brand/scent/flavor words) to retry the local search with.
async function suggestGenericCategoryTerms(
  productDescription: string,
  specifics: Record<string, string>
): Promise<string[]> {
  const schema = {
    type: "object",
    properties: {
      terms: {
        type: "array",
        items: { type: "string" },
        description: "2-5 generic product-category search terms, lowercase, no brand/scent/flavor names, e.g. ['air freshener', 'home fragrance']",
      },
    },
    required: ["terms"],
    additionalProperties: false,
  } as const;

  const specificsLine = Object.entries(specifics)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  let response;
  try {
    response = await anthropic.messages.create(
      {
        // Brainstorming a few generic keywords — simple, high-volume, low
        // stakes (a miss just falls through to web search), so this doesn't
        // need Opus-level reasoning.
        model: "claude-haiku-4-5",
        max_tokens: 256,
        output_config: { format: { type: "json_schema", schema } },
        messages: [
          {
            role: "user",
            content: `Product: "${productDescription}"${specificsLine ? `\nKnown specifics: ${specificsLine}` : ""}

This product's title is dominated by brand/scent/flavor words that won't literally appear in a retail category name. Suggest 2-5 generic, category-taxonomy-style search terms for what this product actually IS (its general type), ignoring brand names, scent/flavor names, and marketing words. E.g. for "Glade Bergamot & Eucalyptus Automatic Spray Refill", good terms are "air freshener", "home fragrance", "spray refill" — not "glade", "bergamot", or "eucalyptus".`,
          },
        ],
      },
      { timeout: 15_000, maxRetries: 0 }
    );
  } catch (e) {
    console.error(`[categoryLookup] generic-terms call failed`, e);
    return [];
  }

  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(
    textBlock && "text" in textBlock ? textBlock.text : "{}"
  ) as { terms?: string[] };

  return (parsed.terms ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean);
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
        // Picking the best match from a real, bounded candidate list —
        // needs real judgment but not Opus-level reasoning.
        model: "claude-sonnet-5",
        max_tokens: 512,
        output_config: { format: { type: "json_schema", schema } },
        messages: [
          {
            role: "user",
            content: `Product: "${productDescription}"

Pick the single best-matching eBay category for this product from the candidates below (id: full path). Prefer the most specific matching category over a broad parent. Ignore "Collectibles > Advertising" / memorabilia-style categories that just happen to share a brand name (e.g. a candy brand's "Collectibles > Advertising > ... > Hershey & Reese's" category is for vintage tins and ads, not for selling the actual candy) — only pick those if the product itself is explicitly a collectible/vintage/advertising item. If none of them genuinely fit this product, return null.

${candidateList}`,
          },
        ],
      },
      { timeout: 20_000, maxRetries: 0 }
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
        // Web search + interpreting real results needs decent judgment, but
        // this is also the priciest path (tool use, slow) — Sonnet handles
        // it well for a fraction of Opus's cost.
        model: "claude-sonnet-5",
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
      { timeout: 35_000, maxRetries: 0 }
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

  // Web search can hand back a parent category too (same failure mode as the
  // local pick) — check it against our local tree when we have it, and
  // reject rather than silently apply a category we know is a dead end.
  const localMatch = await prisma.ebayCategory.findUnique({ where: { id: parsed.categoryId } });
  if (localMatch) {
    const [leafMatch] = await filterToLeaves([localMatch]);
    if (!leafMatch) {
      console.warn(
        `[categoryLookup] ${itemId}: web search returned non-leaf category ${parsed.categoryId} (${localMatch.name}), rejecting`
      );
      return { categoryId: null, categoryName: null, sourceUrl: null, fromExistingRule: false };
    }
  }

  await applyCategory(itemId, parsed.categoryId, parsed.categoryName ?? parsed.categoryId, parsed.keyword ?? "");

  return {
    categoryId: parsed.categoryId,
    categoryName: parsed.categoryName,
    sourceUrl: parsed.sourceUrl,
    fromExistingRule: false,
  };
}
