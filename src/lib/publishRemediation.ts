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

// The captured name keeps eBay's non-breaking space ("Item Length"),
// which then misses every name lookup and gets saved as a specifics key
// that only looks like "Item Length" (caught 2026-10-15).
function cleanAspectName(captured: string): string {
  return captured.replace(/\s+/g, " ").trim();
}

// eBay aspect name (lowercase) -> the specifics key that already holds the
// same fact.
const ASPECT_EQUIVALENTS: Record<string, string> = {
  shade: "color",
};

// eBay asks for these one per failed publish (confirmed live 2026-10-15:
// a Ziploc lot in 20653 needed Item Width, then Item Length, and Height
// would have been next), so a lookup for one fills in all of them at once.
// One at a time cost a web search and an auto-fix round each, and the
// second search timed out.
const DIMENSION_ASPECTS = ["Item Length", "Item Width", "Item Height"];

function isDimensionAspect(aspectName: string): boolean {
  return DIMENSION_ASPECTS.some((d) => d.toLowerCase() === aspectName.toLowerCase());
}

function valueSchemaHint(aspectNames: string[]): string {
  if (aspectNames.length === 1) {
    return `Once you've found it, respond with exactly one JSON object as your final line, no other text after it:
{"value": "the real value"}

If you can't find or confirm a genuinely accurate value for this exact product, respond with:
{"value": null}`;
  }
  const example = Object.fromEntries(aspectNames.map((n) => [n, "the real value"]));
  return `Once you've found them, respond with exactly one JSON object as your final line, no other text after it:
${JSON.stringify(example)}

Use null for any one you can't find or confirm a genuinely accurate value for.`;
}

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

// Looks up the REAL value of one or more item specifics for this exact
// product (web search, not a guess). Mirrors draftItem.ts's own "never
// guess" policy for anything medical-adjacent (dosage, strength): null
// whenever a genuinely confident value can't be found, rather than an
// invented one.
async function lookUpAspectValues(
  item: Item,
  aspectNames: string[],
  rejectedValue?: string
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = Object.fromEntries(aspectNames.map((n) => [n, null]));
  const specifics = specificsOf(item);
  const productDescription = item.finalTitle ?? item.aiTitle ?? `item ${item.sku}`;
  const specificsLine = Object.entries(specifics)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const quoted = aspectNames.map((n) => `"${n}"`).join(", ");
  const problem = rejectedValue
    ? `eBay rejected "${rejectedValue}" as the item specific ${quoted} for this product`
    : aspectNames.length === 1
      ? `eBay requires the item specific ${quoted} to list this product, but it's currently missing`
      : `eBay requires the item specifics ${quoted} to list this product, but they're currently missing`;
  const lotNote = aspectNames.some((n) => /brand/i.test(n))
    ? `\nIf this is a lot of several brands, give the main brand in the lot (the first one, if tied). Never "Various", "Assorted", "Mixed" or "Multiple".`
    : "";
  const dimensionNote = aspectNames.some(isDimensionAspect)
    ? `\nFor dimensions: one unit of the product as sold (its retail box or package, if it comes in one), in inches, like "11.3 in". Not the whole lot stacked together. All of them describe the same box, one side each. A side already in "Already known specifics" is taken: give the other sides, never that same measurement again under a new name.`
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
Find the real, accurate ${quoted} for this exact real product — check its actual packaging, drug facts/label, or product listing if that's what it would take. Only return a value you are genuinely confident is correct for this specific product. Do not invent or estimate a plausible-sounding value just to fill the field.${lotNote}${dimensionNote}

${valueSchemaHint(aspectNames)}`,
          },
        ],
      },
      // 30s wasn't enough for two web searches (confirmed live 2026-10-15:
      // the Item Length lookup on a Ziploc lot timed out at exactly 30s).
      // MAX_AUTO_FIXES rounds of this still fit the route's 300s budget.
      { timeout: 60_000, maxRetries: 0 }
    );
    await logAiUsage("publish.fix_missing_aspect", response, { itemId: item.id });
  } catch (e) {
    console.error(`[publishRemediation] ${item.id}: lookup for ${quoted} failed`, e);
    return result;
  }

  const fullText = extractText(response.content);
  const jsonMatch = fullText.match(/\{[\s\S]*\}\s*$/);
  let parsed: Record<string, unknown> = {};
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Fall through with the empty default — treated as "no confident value".
    }
  }
  for (const name of aspectNames) {
    const raw = aspectNames.length === 1 ? parsed.value : parsed[name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || (rejectedValue && value.toLowerCase() === rejectedValue.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

async function lookUpAspectValue(item: Item, aspectName: string, rejectedValue?: string): Promise<string | null> {
  return (await lookUpAspectValues(item, [aspectName], rejectedValue))[aspectName];
}

// eBay rejected a publish over a missing required item specific (aspect) —
// e.g. "Dosage" for a health category. Fills it from an equivalent field
// the item already has, or else looks up the real value.
async function fixMissingAspect(item: Item, errorMessage: string): Promise<string | null> {
  const match = errorMessage.match(MISSING_ASPECT_PATTERN);
  if (!match) return null;
  const aspectName = cleanAspectName(match[1]);
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
  if (sameAs && specifics[sameAs]) {
    await saveSpecifics(item.id, { ...specifics, [key]: specifics[sameAs] });
    return `Added ${aspectName}: "${specifics[sameAs]}" (eBay required it).`;
  }

  const names = isDimensionAspect(aspectName)
    ? DIMENSION_ASPECTS.filter((n) => !specifics[ebayAspectNameToSpecificsKey(n)])
    : [aspectName];
  const found = await lookUpAspectValues(item, names);
  // The one eBay actually asked for has to come back, or the next publish
  // fails the same way.
  const asked = names.find((n) => n.toLowerCase() === aspectName.toLowerCase()) ?? aspectName;
  if (!found[asked]) {
    console.log(`[publishRemediation] ${item.id}: no confident value found for "${aspectName}"`);
    return null;
  }
  const added = Object.entries(found).filter((e): e is [string, string] => !!e[1]);
  await saveSpecifics(item.id, {
    ...specifics,
    ...Object.fromEntries(added.map(([n, v]) => [ebayAspectNameToSpecificsKey(n), v])),
  });
  return `Added ${added.map(([n, v]) => `${n}: "${v}"`).join(", ")} (eBay required ${added.length === 1 ? "it" : "them"}).`;
}

// eBay rejected a value it doesn't accept, e.g. Brand "Various" on a
// mixed-brand lot. Looks up the right value; a brand nobody can pin down
// becomes "Unbranded" (eBay's own value for that), and any other aspect is
// dropped so eBay can say whether it actually needs it.
async function fixInvalidAspectValue(item: Item, errorMessage: string): Promise<string | null> {
  const match = errorMessage.match(INVALID_VALUE_PATTERN);
  if (!match) return null;
  const aspectName = cleanAspectName(match[1]);
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
