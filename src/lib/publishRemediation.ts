import { prisma } from "@/lib/prisma";
import { anthropic } from "@/lib/anthropic";
import { logAiUsage } from "@/lib/aiUsage";
import { BLOCKED_WORDS_ERROR, ebayAspectNameToSpecificsKey, toItemForEbayPublish } from "@/lib/ebay";
import { findBlockedPhrases, getBlockedPhrases, removeBlockedPhrases } from "@/lib/blockedWords";
import type { Item, Prisma } from "@/generated/prisma/client";

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

// 'A user error has occurred. Brand has an invalid value of "Various".
// Enter a valid value and try again.' (confirmed live 2026-10-15).
const INVALID_VALUE_PATTERN = /([A-Za-z0-9][A-Za-z0-9\s/&'-]*?)\s+has\s+an\s+invalid\s+value\s+of\s+"([^"]*)"/i;

// eBay aspect name (lowercase) -> the specifics key that already holds the
// same fact.
const ASPECT_EQUIVALENTS: Record<string, string> = {
  shade: "color",
};

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

function specificsOf(item: Item): Record<string, string> {
  return (item.itemSpecifics as Record<string, string> | null) ?? {};
}

async function saveSpecifics(itemId: string, specifics: Record<string, string>) {
  await prisma.item.update({
    where: { id: itemId },
    data: { itemSpecifics: specifics as Prisma.InputJsonValue },
  });
}

// Looks up the REAL value of one item specific for this exact product (web
// search, not a guess). Mirrors draftItem.ts's own "never guess" policy for
// anything medical-adjacent (dosage, strength): null whenever a genuinely
// confident value can't be found, rather than an invented one.
async function lookUpAspectValue(item: Item, aspectName: string, rejectedValue?: string): Promise<string | null> {
  const specifics = specificsOf(item);
  const productDescription = item.finalTitle ?? item.aiTitle ?? `item ${item.sku}`;
  const specificsLine = Object.entries(specifics)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const problem = rejectedValue
    ? `eBay rejected "${rejectedValue}" as the item specific "${aspectName}" for this product`
    : `eBay requires the item specific "${aspectName}" to list this product, but it's currently missing`;
  const lotNote = /brand/i.test(aspectName)
    ? `\nIf this is a lot of several brands, give the main brand in the lot (the first one, if tied). Never "Various", "Assorted", "Mixed" or "Multiple".`
    : "";

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
            content: `${problem}: "${productDescription}"${item.upc ? ` (UPC ${item.upc})` : ""}.${specificsLine ? `\nAlready known specifics: ${specificsLine}` : ""}
${item.finalDescription ? `\nListing description: ${item.finalDescription.slice(0, 1500)}\n` : ""}
Find the real, accurate "${aspectName}" for this exact real product — check its actual packaging, drug facts/label, or product listing if that's what it would take. Only return a value you are genuinely confident is correct for this specific product. Do not invent or estimate a plausible-sounding value just to fill the field.${lotNote}

${VALUE_SCHEMA_HINT}`,
          },
        ],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    await logAiUsage("publish.fix_missing_aspect", response, { itemId: item.id });
  } catch (e) {
    console.error(`[publishRemediation] ${item.id}: lookup for "${aspectName}" failed`, e);
    return null;
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
  const value = parsed.value?.trim();
  if (!value || (rejectedValue && value.toLowerCase() === rejectedValue.toLowerCase())) return null;
  return value;
}

// eBay rejected a publish over a missing required item specific (aspect) —
// e.g. "Dosage" for a health category. Fills it from an equivalent field
// the item already has, or else looks up the real value.
async function fixMissingAspect(item: Item, errorMessage: string): Promise<string | null> {
  const match = errorMessage.match(MISSING_ASPECT_PATTERN);
  if (!match) return null;
  const aspectName = match[1].trim();
  // Printed on this particular unit, not a fact about the product a search
  // could find — and a made-up date on a health product is worse than a
  // failed publish. Left for a person to read off the package.
  if (/expiration/i.test(aspectName)) return null;
  const key = ebayAspectNameToSpecificsKey(aspectName);
  const specifics = specificsOf(item);
  if (specifics[key]) return null; // already has a value — not this gap, don't loop on it

  // Some aspects are just another name for one the draft already filled in.
  // Confirmed live 2026-10-15: a Hempz lip gloss (31802) was rejected with
  // "The item specific Shade is missing" while its color sat right there,
  // and the web search came back empty.
  const sameAs = ASPECT_EQUIVALENTS[aspectName.toLowerCase()];
  const value = (sameAs && specifics[sameAs]) || (await lookUpAspectValue(item, aspectName));
  if (!value) {
    console.log(`[publishRemediation] ${item.id}: no confident value found for "${aspectName}"`);
    return null;
  }
  await saveSpecifics(item.id, { ...specifics, [key]: value });
  return `Added ${aspectName}: "${value}" (eBay required it).`;
}

// eBay rejected a value it doesn't accept, e.g. Brand "Various" on a
// mixed-brand lot. Looks up the right value; a brand nobody can pin down
// becomes "Unbranded" (eBay's own value for that), and any other aspect is
// dropped so eBay can say whether it actually needs it.
async function fixInvalidAspectValue(item: Item, errorMessage: string): Promise<string | null> {
  const match = errorMessage.match(INVALID_VALUE_PATTERN);
  if (!match) return null;
  const aspectName = match[1].trim();
  const rejected = match[2];
  const key = ebayAspectNameToSpecificsKey(aspectName);
  const specifics = { ...specificsOf(item) };
  if (specifics[key] !== rejected) return null; // already changed since — don't loop on it

  const value = (await lookUpAspectValue(item, aspectName, rejected)) ?? (key === "brand" ? "Unbranded" : null);
  if (value) specifics[key] = value;
  else delete specifics[key];
  await saveSpecifics(item.id, specifics);
  return value
    ? `Changed ${aspectName} from "${rejected}" to "${value}" (eBay doesn't accept "${rejected}").`
    : `Removed ${aspectName} "${rejected}" (eBay doesn't accept it).`;
}

// eBay's word filter blocked the title or description. Strips any phrase
// already known to be blocked; if none is there, finds the new one with
// eBay's verify call and remembers it (blockedWords.ts).
async function fixBlockedWords(item: Item, errorMessage: string): Promise<string | null> {
  if (!BLOCKED_WORDS_ERROR.test(errorMessage)) return null;
  const title = item.finalTitle ?? "";
  const description = item.finalDescription ?? "";

  let phrases = await getBlockedPhrases();
  let newTitle = removeBlockedPhrases(title, phrases);
  let newDescription = removeBlockedPhrases(description, phrases);
  let learned = false;
  if (newTitle === title && newDescription === description) {
    const found = await findBlockedPhrases(toItemForEbayPublish(item));
    if (!found) return null;
    phrases = found;
    newTitle = removeBlockedPhrases(title, phrases);
    newDescription = removeBlockedPhrases(description, phrases);
    learned = true;
    if (newTitle === title && newDescription === description) return null;
  }
  await prisma.item.update({
    where: { id: item.id },
    data: { finalTitle: newTitle, finalDescription: newDescription },
  });
  const words = phrases
    .filter((p) => removeBlockedPhrases(`${title} ${description}`, [p]) !== `${title} ${description}`)
    .map((p) => `"${p.phrase}"`)
    .join(", ");
  return learned
    ? `Removed ${words} (eBay's word filter blocks it). New drafts will leave it out from now on.`
    : `Removed ${words} (eBay's word filter blocks it).`;
}

// Tries every automatic fix for this publish error, in turn. Returns a
// plain note of what changed (worth retrying the publish), or null when
// nothing here can fix it and a person has to.
export async function tryAutoFix(itemId: string, errorMessage: string): Promise<string | null> {
  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  for (const fix of [fixMissingAspect, fixInvalidAspectValue, fixBlockedWords]) {
    try {
      const note = await fix(item, errorMessage);
      if (note) {
        console.log(`[publishRemediation] ${itemId}: ${note}`);
        return note;
      }
    } catch (e) {
      console.error(`[publishRemediation] ${itemId}: ${fix.name} failed`, e);
    }
  }
  return null;
}

// Before the first publish attempt: takes known-blocked words out of the
// title and description, including ones typed in by hand on Review, so
// eBay never gets the chance to reject them.
export async function stripKnownBlockedWords(item: Item): Promise<string | null> {
  const phrases = await getBlockedPhrases();
  const title = item.finalTitle ?? "";
  const description = item.finalDescription ?? "";
  const newTitle = removeBlockedPhrases(title, phrases);
  const newDescription = removeBlockedPhrases(description, phrases);
  if (newTitle === title && newDescription === description) return null;
  await prisma.item.update({
    where: { id: item.id },
    data: { finalTitle: newTitle, finalDescription: newDescription },
  });
  return "Removed words eBay's filter blocks from the title/description.";
}
