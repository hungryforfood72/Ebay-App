import { prisma } from "@/lib/prisma";
import { anthropic } from "@/lib/anthropic";
import { logAiUsage } from "@/lib/aiUsage";
import { getCategorySuggestions } from "@/lib/ebay";

type Candidate = { id: string; name: string; path: string };

export type CategoryLookupResult = {
  categoryId: string | null;
  categoryName: string | null;
  sourceUrl: string | null;
  fromExistingRule: boolean;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "your", "pack",
  "unit", "units", "item", "new", "used", "single", "best", "premium",
  // Our own listing words ("Lot of 2 ..."), never what the product is.
  "lot", "lots",
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
// 2. eBay's own category suggestions for the title (Taxonomy API) at the
//    top of the shortlist, plus a local word search over eBay's full
//    category tree (imported from their official export, see
//    references/ebay-category-ids.md) behind them. A quick, tool-free
//    Claude call picks the best fit from those real candidates.
// 3. If Claude rejects them all, ask it for a few generic category-type
//    terms (e.g. "air freshener" for a Glade refill), widen the local
//    search with those and pick again.
// 4. Still nothing: eBay's top suggestion, unsaved as a rule.
// 5. AI web search, only if eBay's suggestion service was down or empty.
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
  const searchText = [productDescription, specifics.type, specifics.product, specifics.brand]
    .filter(Boolean)
    .join(" ");

  const words = significantWords(searchText);
  // eBay's own suggestions lead the shortlist; our word search fills in
  // behind them in case eBay's are off. Claude still makes the call.
  const suggested = await ebaySuggestedCategories(itemId, productDescription);
  let candidates = mergeCandidates(suggested, await findLocalCandidates(words));

  console.log(
    `[categoryLookup] ${itemId}: title="${productDescription}", words=${JSON.stringify(words)}, eBay suggested=${suggested.length}, candidates=${candidates.length}`
  );

  let picked = candidates.length > 0 ? await timedPick(itemId, productDescription, candidates, suggested) : null;

  if (!picked) {
    // Literal word overlap found nothing usable — ask Claude for generic
    // category-type terms (e.g. "air freshener", "home fragrance") instead
    // of brand/scent words, and try the local tree again with those.
    const genericTerms = await suggestGenericCategoryTerms(productDescription, specifics);
    console.log(`[categoryLookup] ${itemId}: generic terms=${JSON.stringify(genericTerms)}`);

    if (genericTerms.length > 0) {
      // The phrases themselves ("incontinence underwear") rarely appear
      // whole in a category name; their words often do.
      const genericWords = Array.from(new Set([...genericTerms, ...genericTerms.flatMap(significantWords)]));
      const broaderCandidates = await findLocalCandidates(genericWords);
      candidates = mergeCandidates(candidates, broaderCandidates);

      console.log(`[categoryLookup] ${itemId}: broadened local candidates=${candidates.length}`);
      if (candidates.length > 0) {
        picked = await timedPick(itemId, productDescription, candidates, suggested);
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

  if (suggested.length > 0) {
    // Claude turned everything down, but eBay's top suggestion has been
    // right far more often than the web search below, which on 2026-10-05
    // came back empty 3 times out of 3 (17-38s each) on a title eBay placed
    // instantly. Applied without saving a keyword rule, since nothing
    // double-checked it.
    const top = suggested[0];
    console.log(`[categoryLookup] ${itemId}: no pick, using eBay's top suggestion ${top.id} (${top.path})`);
    await applyCategory(itemId, top.id, top.name, "");
    return { categoryId: top.id, categoryName: top.name, sourceUrl: null, fromExistingRule: false };
  }

  // Only when eBay's suggestion service is down or had nothing.
  return searchWebForCategory(itemId, productDescription);
}

// eBay's suggestions as rows from our own tree, in eBay's order, leaves
// only. Empty on any failure: the word search still runs without it.
async function ebaySuggestedCategories(itemId: string, productDescription: string): Promise<Candidate[]> {
  try {
    const ids = await getCategorySuggestions(productDescription);
    if (ids.length === 0) return [];
    const rows = await prisma.ebayCategory.findMany({ where: { id: { in: ids } } });
    const leaves = await filterToLeaves(rows);
    return ids.map((id) => leaves.find((c) => c.id === id)).filter((c): c is Candidate => Boolean(c));
  } catch (e) {
    console.error(`[categoryLookup] ${itemId}: eBay category suggestions failed`, e);
    return [];
  }
}

function mergeCandidates(first: Candidate[], second: Candidate[]): Candidate[] {
  const merged = new Map(first.map((c) => [c.id, c]));
  for (const c of second) if (!merged.has(c.id)) merged.set(c.id, c);
  return Array.from(merged.values());
}

// Each word gets its own pool query, so a common word can't crowd out a
// rare one. One combined query with an unordered `take: 2000` let "women"
// and "underwear" (thousands of matches) fill the pool before
// "incontinence" got in, so Incontinence Aids never reached the shortlist
// for Always Discreet underwear (2026-10-05).
const POOL_PER_WORD = 300;

async function findLocalCandidates(words: string[]) {
  if (words.length === 0) return [];

  // Matched on whole words (plurals allowed), not substrings: Postgres
  // `contains` can't do word boundaries, and substring matching let "snow"
  // rank Snowsuits and "toner" rank copier Toner level with "Cleansers &
  // Toners" (a Thayers facial toner, 2026-09-29).
  const patterns = words.map(
    (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e?s)?\\b`, "i")
  );
  const totalCategories = await prisma.ebayCategory.count();
  const pool = new Map<string, { id: string; name: string; path: string }>();
  // A rare word says far more about what the product is than a common one:
  // "incontinence" (1 category) vs. "women" (hundreds). Inverse frequency.
  const weights: number[] = [];
  for (const [i, w] of words.entries()) {
    const rows = await prisma.ebayCategory.findMany({
      where: { path: { contains: w, mode: "insensitive" } },
    });
    const hits = rows.filter((c) => patterns[i].test(c.path));
    weights.push(Math.log(totalCategories / (hits.length + 1)));
    for (const c of hits.slice(0, POOL_PER_WORD)) pool.set(c.id, c);
  }

  const scored = Array.from(pool.values()).map((c) => {
    let score = 0;
    patterns.forEach((re, i) => {
      if (re.test(c.name)) score += 3 * weights[i];
      else if (re.test(c.path)) score += weights[i];
    });
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

// Loose overlap check, not exact match — web search's phrasing of a
// category name won't always exactly match our tree's (e.g. "Chips" vs.
// "Potato Chips"), but a genuine match still shares real words with either
// the leaf name or its full breadcrumb path.
function categoryNameRoughlyMatches(claimed: string, actual: { name: string; path: string }): boolean {
  const claimedLower = claimed.trim().toLowerCase();
  const nameLower = actual.name.toLowerCase();
  const pathLower = actual.path.toLowerCase();
  return (
    nameLower.includes(claimedLower) ||
    claimedLower.includes(nameLower) ||
    pathLower.includes(claimedLower)
  );
}

async function timedPick(
  itemId: string,
  productDescription: string,
  candidates: Candidate[],
  suggested: Candidate[]
) {
  const pickStart = Date.now();
  const picked = await pickBestLocalCategory(productDescription, candidates, suggested);
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
    await logAiUsage("category.generic_terms", response);
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
  candidates: Candidate[],
  suggested: Candidate[]
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

  const suggestedRank = new Map(suggested.map((c, i) => [c.id, i + 1]));
  const candidateList = candidates
    .map((c) => `${c.id}: ${c.path}${suggestedRank.has(c.id) ? ` [eBay suggestion #${suggestedRank.get(c.id)}]` : ""}`)
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

Pick the single best-matching eBay category for this product from the candidates below (id: full path). Candidates marked [eBay suggestion #N] are eBay's own suggestions for this title, best first. They're usually right, but check that the one you pick really fits the product. Prefer the most specific matching category over a broad parent. Ignore "Collectibles > Advertising" / memorabilia-style categories that just happen to share a brand name (e.g. a candy brand's "Collectibles > Advertising > ... > Hershey & Reese's" category is for vintage tins and ads, not for selling the actual candy) — only pick those if the product itself is explicitly a collectible/vintage/advertising item. "Books & Magazines" is for books with printed content (eBay then requires an Author); blank notebooks, journals, composition books and planners are school/office supplies, not books. If none of them genuinely fit this product, return null.

${candidateList}`,
          },
        ],
      },
      { timeout: 20_000, maxRetries: 0 }
    );
    await logAiUsage("category.pick_local", response);
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

// Last resort, only when eBay's suggestion service was down or had nothing.
// Weak on its own: on 2026-10-05 it came back empty 3 times out of 3
// (17-38s each) on a title eBay's suggestions placed instantly.
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
    await logAiUsage("category.web_search", response, { itemId });
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

  // Web search free-forms both an ID and a name from what it reads on
  // ebay.com, unlike the local pick (which only ever chooses from real
  // (id, name, path) rows already in our own tree) — so it can return an ID
  // that's flat-out wrong in ways the local pick can't: retired/nonexistent,
  // or a real leaf that just isn't what it claims. Our local tree is a full,
  // current snapshot of eBay's real category list (~20,571 categories,
  // re-verified byte-identical against eBay's own live export) — trust it
  // over the web search's own claim rather than the other way around.
  const localMatch = await prisma.ebayCategory.findUnique({ where: { id: parsed.categoryId } });

  if (!localMatch) {
    console.warn(
      `[categoryLookup] ${itemId}: web search returned category ${parsed.categoryId}, not found in our local tree at all — rejecting`
    );
    return { categoryId: null, categoryName: null, sourceUrl: null, fromExistingRule: false };
  }

  const [leafMatch] = await filterToLeaves([localMatch]);
  if (!leafMatch) {
    console.warn(
      `[categoryLookup] ${itemId}: web search returned non-leaf category ${parsed.categoryId} (${localMatch.name}), rejecting`
    );
    return { categoryId: null, categoryName: null, sourceUrl: null, fromExistingRule: false };
  }

  if (parsed.categoryName && !categoryNameRoughlyMatches(parsed.categoryName, localMatch)) {
    // The ID exists and is a real leaf, but for something else entirely —
    // e.g. web search once claimed an ID was "Chips & Crisps" when our tree
    // (matching eBay's own real export) says it's actually "Uganda" under
    // Stamps. A technically-valid-but-wrong ID is worse than no category.
    console.warn(
      `[categoryLookup] ${itemId}: web search claimed ${parsed.categoryId} was "${parsed.categoryName}" but it's actually "${localMatch.path}" — rejecting`
    );
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
