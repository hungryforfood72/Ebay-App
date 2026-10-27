import { prisma } from "@/lib/prisma";
import { anthropic, fetchImageAsBase64 } from "@/lib/anthropic";
import { logAiUsage } from "@/lib/aiUsage";
import {
  ebayAspectNameToSpecificsKey,
  getCategoryAspects,
  MULTI_VALUE_SEPARATOR,
  type CategoryAspect,
} from "@/lib/ebay";
import type { Item, Prisma } from "@/generated/prisma/client";
import type Anthropic from "@anthropic-ai/sdk";

// Fills the item specifics eBay lists for the item's category, once it
// has one (Cristian, 2026-10-26: "optimize listings to show up to the
// buyers that are looking"). The draft only ever filled a fixed ~10
// (brand, type, size...), and anything else was added only when eBay
// rejected a publish for a missing required one. These are what eBay's
// search filters and Best Match use: MPN (a REF number like 416409),
// Features, Product Line, Active Ingredients. Same "never guess" rule as
// the draft: a value has to be on the package, in the UPC data or in the
// description.

// Read off this exact unit or set elsewhere, never from the product. A
// warranty (Durability Guarantee) reads as our promise, not the maker's:
// the live run proposed "Lifetime Warranty" for a blood pressure cuff.
const SKIP_ASPECTS = new Set(
  [
    "Expiration Date", "UPC", "EAN", "ISBN", "GTIN", "Unit Quantity", "Unit Type", "California Prop 65 Warning",
    "Durability Guarantee", "Warranty", "Manufacturer Warranty",
  ].map((n) => n.toLowerCase())
);
// Filler eBay shoppers can't filter on, and that only hides a real gap.
const FILLER_VALUE = /^(n\/?a|none|unknown|various|assorted|mixed|multiple|see (description|photos?)|does not apply|not applicable|other)$/i;
// eBay's limit for most aspect values when the category doesn't give one.
const DEFAULT_MAX_LENGTH = 65;
const MAX_MULTI_VALUES = 6;
const MAX_PHOTOS = 4;

const FILL_SCHEMA = {
  type: "object",
  properties: {
    specifics: {
      type: "array",
      description: "Only the item specifics you can confirm for this exact product. Leave an item specific out entirely rather than guess.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The item specific's name, exactly as listed" },
          values: { type: "array", items: { type: "string" } },
        },
        required: ["name", "values"],
        additionalProperties: false,
      },
    },
  },
  required: ["specifics"],
  additionalProperties: false,
} as const;

function hasValue(specifics: Record<string, string>, aspectName: string): boolean {
  return Boolean(specifics[ebayAspectNameToSpecificsKey(aspectName)] ?? specifics[aspectName]);
}

// The aspects worth asking about: every one the category lists, not just
// the "recommended" ones (ostomy pouches, 184561, mark only Brand as
// recommended, yet list Intended Use, MPN, Opening and Wafer Shape as
// optional, and all of them show as search filters). Not already filled
// in, and not one that's set somewhere else.
function aspectsToFill(aspects: CategoryAspect[], specifics: Record<string, string>): CategoryAspect[] {
  return aspects.filter((a) => !SKIP_ASPECTS.has(a.name.toLowerCase()) && !hasValue(specifics, a.name));
}

function describeAspect(a: CategoryAspect): string {
  const rule = a.selectionOnly
    ? `pick from exactly these: ${a.values.join("; ")}`
    : a.values.length
      ? `free text; eBay's usual values include: ${a.values.join("; ")}`
      : "free text";
  return `- ${a.name} (${a.multi ? `up to ${MAX_MULTI_VALUES} values` : "one value"}; ${rule})`;
}

// The UPC lookup result minus the store offers and image links, which are
// most of its size and say nothing about the product itself.
function upcFacts(item: Item): string {
  const data = item.upcLookupData as { items?: Record<string, unknown>[] } | null;
  const first = data?.items?.[0];
  if (!first) return "";
  const { offers: _offers, images: _images, ...facts } = first;
  void _offers;
  void _images;
  return JSON.stringify(facts).slice(0, 2500);
}

// A value eBay will take for this aspect: one of its own values when it
// matches (their spelling), never filler, within the length limit.
function cleanValues(aspect: CategoryAspect, raw: string[]): string[] {
  const max = aspect.maxLength ?? DEFAULT_MAX_LENGTH;
  const out: string[] = [];
  for (const r of raw) {
    const value = r.trim();
    if (!value || FILLER_VALUE.test(value) || value.length > max || value.includes(MULTI_VALUE_SEPARATOR.trim())) continue;
    const listed = aspect.values.find((v) => v.toLowerCase() === value.toLowerCase());
    if (aspect.selectionOnly && !listed) continue;
    const final = listed ?? value;
    if (!out.some((v) => v.toLowerCase() === final.toLowerCase())) out.push(final);
  }
  return out.slice(0, aspect.multi ? MAX_MULTI_VALUES : 1);
}

export type FilledSpecifics = Record<string, string>;

// Works out the recommended specifics this item is missing, by eBay
// aspect name, each value already joined for storage. Saves them under
// the item's existing specifics (which always win) unless `save` is false
// (the live-listing tune-up shows them first). Empty when the item has no
// category, is a bundle (one brand/MPN can't describe a mixed lot), or
// nothing could be confirmed.
export async function fillCategorySpecifics(
  itemId: string,
  { save = true }: { save?: boolean } = {}
): Promise<FilledSpecifics> {
  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  if (!item.categoryId || item.isBundle) return {};
  const specifics = (item.itemSpecifics as Record<string, string> | null) ?? {};
  const targets = aspectsToFill(await getCategoryAspects(item.categoryId), specifics);
  if (targets.length === 0) return {};

  const known = Object.entries(specifics)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const facts = upcFacts(item);
  const prompt = `This eBay listing is missing item specifics that eBay lists for its category (buyers filter search results by them). Fill in the ones you can confirm for this exact product.

Title: ${item.finalTitle ?? item.aiTitle ?? "(none yet)"}
${item.upc ? `UPC: ${item.upc}\n` : ""}${facts ? `UPC lookup data (may be incomplete or wrong in places): ${facts}\n` : ""}${known ? `\nItem specifics it already has:\n${known}\n` : ""}${item.finalDescription ? `\nDescription:\n${item.finalDescription.slice(0, 2000)}\n` : ""}
Item specifics to fill:
${targets.map(describeAspect).join("\n")}

Rules:
- Only give a value that's printed on the package or stated in the UPC data or the description. Don't infer it from what products like this are usually like. Leave an item specific out rather than guess. A wrong value is worse than none.
- If the product suits several values and the item specific takes one (a drainable pouch is for colostomy and ileostomy), leave it out unless the package names one.
- Describe the product itself, not its packaging (no bottle color or container material) and not the listing (one unit's features, not the lot).
- Manufacturer is the company that makes it (Procter & Gamble), not the brand, and only if it's printed.
- MPN / Model: the manufacturer's part, model, REF or catalog number printed on the package. Never the UPC.
- Use one of eBay's usual values only when it says exactly the same thing as the package. Never round to the nearest one: a 0.44 fl oz tube is "0.44 fl oz", not "0.4 fl oz".
- Volume is for liquids measured in fl oz or mL. Leave it out for a solid sold by weight (a 2.6 oz deodorant stick).
- Keep each value short, a few words at most. Never "N/A", "Various", "Unknown" or "See description".`;

  const photoBlocks = await Promise.all(
    item.photoUrls.slice(0, MAX_PHOTOS).map(async (url): Promise<Anthropic.Messages.ContentBlockParam | null> => {
      try {
        const { data, mediaType } = await fetchImageAsBase64(url);
        return { type: "image", source: { type: "base64", media_type: mediaType, data } };
      } catch {
        return null;
      }
    })
  );
  const response = await anthropic.messages.create(
    {
      // Reading a package and matching it to a list, not deep reasoning.
      model: "claude-sonnet-5",
      max_tokens: 2048,
      output_config: { format: { type: "json_schema", schema: FILL_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            ...photoBlocks.filter((b): b is Anthropic.Messages.ContentBlockParam => b != null),
            { type: "text", text: prompt },
          ],
        },
      ],
    },
    // Runs after the draft and category lookup on a new item (items
    // route's after()), inside the same function time limit.
    { timeout: 40_000, maxRetries: 0 }
  );
  await logAiUsage("draft.category_specifics", response, { itemId });
  if (response.stop_reason === "max_tokens") throw new Error("Category specifics fill was cut off (hit max_tokens)");

  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}") as {
    specifics?: { name: string; values: string[] }[];
  };
  const filled: FilledSpecifics = {};
  for (const entry of parsed.specifics ?? []) {
    const aspect = targets.find((a) => a.name.toLowerCase() === entry.name.trim().toLowerCase());
    if (!aspect || filled[aspect.name]) continue;
    const values = cleanValues(aspect, entry.values ?? []);
    if (values.length) filled[aspect.name] = values.join(MULTI_VALUE_SEPARATOR);
  }
  if (save && Object.keys(filled).length > 0) {
    // Re-read so a specific typed on Review while this ran isn't lost.
    const latest = await prisma.item.findUniqueOrThrow({ where: { id: itemId }, select: { itemSpecifics: true } });
    const current = (latest.itemSpecifics as Record<string, string> | null) ?? {};
    const additions = Object.fromEntries(
      Object.entries(filled).map(([name, value]) => [ebayAspectNameToSpecificsKey(name), value])
    );
    await prisma.item.update({
      where: { id: itemId },
      data: { itemSpecifics: { ...additions, ...current } as Prisma.InputJsonValue },
    });
  }
  return filled;
}
