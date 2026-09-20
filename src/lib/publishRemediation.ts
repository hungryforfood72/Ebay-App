import { prisma } from "@/lib/prisma";
import { anthropic } from "@/lib/anthropic";
import { ebayAspectNameToSpecificsKey } from "@/lib/ebay";
import type { Prisma } from "@/generated/prisma/client";

// eBay's real error text: 'A user error has occurred. The item specific
// Dosage is missing. Add Dosage to this listing, enter a valid value, and
// then try again.' — the aspect name is repeated but only the first,
// tightly-bounded capture is used.
//
// Confirmed live: eBay's actual text uses a NON-BREAKING space (U+00A0,
// char code 160) between "Dosage" and "is" — not a plain space — which
// silently failed to match a plain " " in this pattern (a real error
// message tested null against what looked, printed to a terminal,
// identical to a hand-typed test string). \s in a JS regex already covers
// U+00A0, so \s+ throughout instead of literal spaces handles this and any
// other whitespace variant eBay's text might use elsewhere in the string.
const MISSING_ASPECT_PATTERN = /item\s+specific\s+([A-Za-z0-9\s/&'-]+?)\s+is\s+missing/i;

const VALUE_SCHEMA_HINT = `Once you've found it, respond with exactly one JSON object as your final line, no other text after it:
{"value": "the real value"}

If you can't find or confirm a genuinely accurate value for this exact product, respond with:
{"value": null}`;

// A web-search-enabled response splits its answer across multiple "text"
// blocks whenever it cites a source — concatenate all of them, not just the
// first (see the identical fix in sourcingAgent.ts's extractText, found the
// same way: a real check kept returning an empty answer because only the
// opening clause was ever read).
function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// eBay rejected a publish over a missing required item specific (aspect) —
// e.g. "Dosage" for a health category. Rather than leave that for manual
// digging, look up the REAL value for this exact product (web search, not
// a guess) and fill it in so the next publish attempt can clear the same
// check. Mirrors draftItem.ts's own "never guess" policy for anything
// medical-adjacent (dosage, strength) — returns false, leaving the item
// untouched, whenever a genuinely confident value can't be found, rather
// than publishing with an invented number.
//
// Returns true only when it changed itemSpecifics (worth retrying the
// publish); false for anything else, including an error message that isn't
// this kind of gap at all.
export async function tryFixMissingAspect(itemId: string, errorMessage: string): Promise<boolean> {
  const match = errorMessage.match(MISSING_ASPECT_PATTERN);
  if (!match) return false;
  const aspectName = match[1].trim();
  const key = ebayAspectNameToSpecificsKey(aspectName);

  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  const specifics = (item.itemSpecifics as Record<string, string> | null) ?? {};
  if (specifics[key]) return false; // already has a value — not this gap, don't loop on it

  const productDescription = item.finalTitle ?? item.aiTitle ?? `item ${item.sku}`;
  const specificsLine = Object.entries(specifics)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  let response;
  try {
    response = await anthropic.messages.create(
      {
        // Web search + judging a real product's actual labeled spec — needs
        // real judgment (and the caution not to fabricate one), but this is
        // a narrow, bounded lookup, not deep reasoning.
        model: "claude-sonnet-5",
        max_tokens: 1024,
        output_config: { effort: "low" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
        messages: [
          {
            role: "user",
            content: `eBay requires the item specific "${aspectName}" to list this product, but it's currently missing: "${productDescription}"${item.upc ? ` (UPC ${item.upc})` : ""}.${specificsLine ? `\nAlready known specifics: ${specificsLine}` : ""}

Find the real, accurate "${aspectName}" for this exact real product — check its actual packaging, drug facts/label, or product listing if that's what it would take. Only return a value you are genuinely confident is correct for this specific product. Do not invent or estimate a plausible-sounding value just to fill the field.

${VALUE_SCHEMA_HINT}`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
  } catch (e) {
    console.error(`[publishRemediation] ${itemId}: lookup for "${aspectName}" failed`, e);
    return false;
  }

  const fullText = extractText(response.content);
  const jsonMatch = fullText.match(/\{[\s\S]*\}\s*$/);
  let parsed: { value?: string | null } = {};
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Fall through with the empty default — treated as "no confident value".
    }
  }
  if (!parsed.value) {
    console.log(`[publishRemediation] ${itemId}: no confident value found for "${aspectName}"`);
    return false;
  }

  await prisma.item.update({
    where: { id: itemId },
    data: { itemSpecifics: { ...specifics, [key]: parsed.value } as Prisma.InputJsonValue },
  });
  console.log(`[publishRemediation] ${itemId}: filled "${aspectName}" (key "${key}") = "${parsed.value}"`);
  return true;
}
