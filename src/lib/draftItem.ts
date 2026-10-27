import { prisma } from "@/lib/prisma";
import { returnDraftNote } from "@/lib/warehouse/returns";
import { lookupUpc } from "@/lib/upcLookup";
import { anthropic, fetchImageAsBase64 } from "@/lib/anthropic";
import { logAiUsage } from "@/lib/aiUsage";
import { truncateTitle } from "@/lib/ebayTitle";
import { getBlockedPhrases, removeBlockedPhrases } from "@/lib/blockedWords";
import { breakdownDescriptionHtml, breakdownDescriptionText, describeBreakdown, normalizeBreakdown } from "@/lib/expirationBreakdown";
import { formatExpiration } from "@/lib/formatExpiration";
import type { Item, Prisma } from "@/generated/prisma/client";
import type Anthropic from "@anthropic-ai/sdk";

const SPECIFICS_SCHEMA = {
  type: "object",
  description: "eBay item specifics. Use null for anything not confidently known from the photo or UPC data — never guess.",
  properties: {
    brand: { type: ["string", "null"], description: "Brand name, or null if not identifiable. For a bundle of different brands, use the dominant brand (the first one, if tied). Never 'Various', 'Assorted', 'Mixed' or 'Multiple': eBay rejects those as a Brand." },
    type: { type: ["string", "null"], description: "Product type, e.g. 'Sticker', 'Hair Dye', 'Action Figure'. For a bundle, something like 'Bundle' or 'Lot'." },
    product: {
      type: ["string", "null"],
      description: "A short, generic name for what this product actually is, for eBay's 'Product' item specific (required by some categories) — e.g. 'Vitamin C Drops', 'Air Freshener Refill'. Usually close to type but phrased as a plain product name rather than a category label.",
    },
    color: { type: ["string", "null"], description: "Primary color, or null if not visually clear" },
    size: { type: ["string", "null"], description: "Size (clothing size, dimensions, count, etc.), or null" },
    material: { type: ["string", "null"], description: "Material, or null if not identifiable" },
    dosage: {
      type: ["string", "null"],
      description: "Dose or strength per unit, for medicines/vitamins/supplements only — e.g. '500 mg', '17.2 mg per tablet', '10 mg/5 mL'. Null for anything that isn't a medicine or supplement, or if the strength isn't legible in the photo/UPC data. eBay hard-caps this field at 65 characters — for multi-ingredient combo products, list only the 1-2 most prominent active ingredients rather than every one, so it stays under that limit.",
    },
    department: {
      type: ["string", "null"],
      description: "eBay's standard clothing 'Department' item specific, for clothing/shoes/accessories only — one of 'Men', 'Women', 'Unisex Adult', 'Boys', 'Girls', 'Baby & Toddler', or similar. Null for anything that isn't clothing.",
    },
    sizeType: {
      type: ["string", "null"],
      description: "eBay's standard clothing 'Size Type' item specific, for clothing/shoes/accessories only — one of 'Regular', 'Big & Tall', 'Plus', 'Petite', 'Maternity'. Use 'Regular' for a standard-fit item unless the packaging/listing clearly indicates otherwise. Null for anything that isn't clothing.",
    },
    volume: {
      type: ["string", "null"],
      description: "eBay's 'Volume' item specific, for beverages and drink mixes only — e.g. '16 fl oz', '1 Gallon'. For a powder/stick drink mix meant to be reconstituted, use the volume of liquid the packaging directs it to be mixed with (this is usually printed right on the box, e.g. 'Mix with 16 fl oz of water'), not the dry product's own size. Null for anything that isn't a beverage or drink mix.",
    },
  },
  required: ["brand", "type", "product", "color", "size", "material", "dosage", "department", "sizeType", "volume"],
  additionalProperties: false,
} as const;

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "eBay listing title, 80 characters or fewer",
    },
    description: {
      type: "string",
      description: "eBay listing description as plain text: a one or two sentence summary, then short 'What's included:', 'Details:' and 'Condition:' sections of '- ' bullets",
    },
    specifics: SPECIFICS_SCHEMA,
    countPerPackage: {
      type: ["integer", "null"],
      description:
        "How many pieces are inside ONE unit of this listing, as printed on the package in the photos: 30 for a box of 30 bandages ('30 ct'), 60 for a bottle of 60 tablets, 10 for a box of 10 drink-mix sticks, 1 for something sold as one piece (an individually wrapped beef stick, a single tube of lotion). If this is a multi-pack or lot, count inside one of its units, not the whole lot. Null if the photo and UPC data don't make it clear.",
    },
    // eBay doesn't allow prescription devices (Cristian, 2026-10-25: a Bard
    // leg bag listing was removed). Read off the package, like the count.
    rxOnly: {
      type: "boolean",
      description:
        "true only if a photo visibly shows the package marked prescription-only: 'Rx Only', 'Rx only', '℞ only', or 'Caution: Federal law restricts this device to sale by or on the order of a physician'. false otherwise.",
    },
    rxOnlyNote: {
      type: ["string", "null"],
      description: "When rxOnly is true, the exact marking you see and where on the package (e.g. 'Rx Only, top right of the front'). Null otherwise.",
    },
  },
  required: ["title", "description", "specifics", "countPerPackage", "rxOnly", "rxOnlyNote"],
  additionalProperties: false,
} as const;

type Draft = {
  title?: string;
  description?: string;
  specifics?: Record<string, string | null>;
  countPerPackage?: number | null;
  rxOnly?: boolean;
  rxOnlyNote?: string | null;
};

// Shared by draftItem and draftBundleItem: truncates the title, respects
// manual edits (a "Regenerate" only overwrites finalTitle/finalDescription
// if they still match the *previous* AI draft, i.e. the reviewer never
// touched them), merges specifics without clobbering reviewer-set ones, and
// saves. `extra` carries whatever field(s) are specific to that draft path
// (upcLookupData for a single item, bundleComponents for a bundle).
async function applyDraft(item: Item, draft: Draft, extra: Prisma.ItemUpdateInput = {}) {
  // eBay hard-rejects listing titles over 80 characters. The prompt asks for
  // 80 or fewer, but that's a hint, not a guarantee — Claude has gone over
  // (especially when working an expiration date into the title), so enforce
  // it here rather than trust the model.
  // Words eBay's filter blocks come out of the draft before anyone sees it,
  // since the listing can't go live with them anyway.
  const blocked = await getBlockedPhrases();
  const draftTitle = draft.title ? truncateTitle(removeBlockedPhrases(draft.title, blocked)) : draft.title;
  if (draft.description) draft = { ...draft, description: removeBlockedPhrases(draft.description, blocked) };

  const titleUnedited = !item.finalTitle || item.finalTitle === item.aiTitle;
  const descriptionUnedited =
    !item.finalDescription || item.finalDescription === item.aiDescription;

  // Only keep specifics Claude was actually confident about (non-null), and
  // don't clobber ones the reviewer has already filled in/edited by hand.
  const newSpecifics = Object.fromEntries(
    Object.entries(draft.specifics ?? {}).filter(([, v]) => v)
  );
  const existingSpecifics = (item.itemSpecifics as Record<string, string> | null) ?? {};
  const mergedSpecifics = { ...newSpecifics, ...existingSpecifics };

  return prisma.item.update({
    where: { id: item.id },
    data: {
      aiTitle: draftTitle ?? null,
      aiDescription: draft.description ?? null,
      finalTitle: titleUnedited ? (draftTitle ?? item.finalTitle) : item.finalTitle,
      finalDescription: descriptionUnedited
        ? (draft.description ?? item.finalDescription)
        : item.finalDescription,
      itemSpecifics:
        Object.keys(mergedSpecifics).length > 0
          ? (mergedSpecifics as Prisma.InputJsonValue)
          : undefined,
      ...extra,
    },
  });
}

async function imageContentBlock(url: string): Promise<Anthropic.Messages.ContentBlockParam | null> {
  try {
    const { data, mediaType } = await fetchImageAsBase64(url);
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  } catch {
    return null;
  }
}

// How a title gets found (Cristian, 2026-10-26: show up to the buyers who
// are looking). eBay search matches the words in the title, and phone
// search results cut titles short, so the product leads and the pack count
// follows it. Live titles before this often opened with "Lot of 3" or "2x"
// and spent ~15 characters on "Exp MM/DD/YYYY", a thing nobody searches.
// Not used for bundles: a mixed lot has no one product to lead with.
export const TITLE_RULES = `Title rules (it's how buyers find the listing in eBay search):
- Lead with what a buyer types: brand, product line, then what the item is, in the plain words shoppers search ("Ostomy Pouch", "Cold Remedy Drops").
- Then the facts that narrow a search: model, MPN or REF number, size, count, strength, scent or flavor, color.
- The pack or lot count ("2 Pack", "Lot of 3", "2 Boxes") goes after the product name and its size, never first.
- When there's room, add one other common name buyers search for the same thing (e.g. "Colostomy Bag" after "Ostomy Pouch"). Never another brand's name, and no repeated words.
- It should read as a product name: no stray single word tacked on the end to fill space.
- Use the space: aim for 70 to 80 characters, never more than 80.
- No filler or hype ("L@@K", "Wow", "Must Have", "Fast Shipping", "Great Deal"), no punctuation runs, not all caps.
- An expiration or best-by date goes in only if it still fits after all of that, at the very end, as "Exp MM/DD/YYYY". The date is always in the item specifics and the description either way.`;

const MAX_DRAFT_PHOTOS = 8;
// Per bundle component, each in its own request (see nameComponent).
const MAX_COMPONENT_PHOTOS = 4;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Looks up the item's UPC (caching the result) and asks Claude to draft an
// eBay title + description from that data plus the item's photos.
export async function draftItem(itemId: string) {
  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });

  if (item.isBundle) return await draftBundleItem(item);

  // No UPC (custom/handmade items, e.g. our own t-shirts) — nothing to look
  // up, draft from the photo and whatever else was entered instead.
  let upcLookupData: Prisma.InputJsonValue | null = null;
  if (item.upc) {
    if (item.upcLookupData) {
      upcLookupData = item.upcLookupData as Prisma.InputJsonValue;
    } else {
      try {
        upcLookupData = (await lookupUpc(item.upc)) as Prisma.InputJsonValue;
      } catch {
        upcLookupData = { error: "UPC lookup failed" };
      }
    }
  }

  const packNote = item.isMultipack
    ? `This is a multi-pack of ${item.packSize} units — reflect that in the title and description.`
    : "This is a single unit, not a multi-pack.";

  // Confirmed live: given the raw stock count, the model wrote a
  // "Quantity available: 2. You will receive one figure per purchase."
  // line straight into the description — technically accurate, but a
  // buyer skimming past "Quantity available: 2" right next to a "you get
  // 1" clarifier can easily misread it as getting 2. eBay already shows
  // the real stock count separately via its own listing quantity field,
  // so the description never needs to restate a raw number at all.
  const quantityNote =
    !item.isMultipack && item.quantity > 1
      ? `Quantity available: ${item.quantity} (this many separate units are in stock; each purchase is for exactly 1). This number is for your context only — do NOT write a raw "Quantity available: N" line in the description, since eBay already shows the stock count separately and restating it reads ambiguously next to a "you get 1" clarifier. If the description needs to say anything about this at all, phrase it so a skimming buyer can't possibly read it as getting more than 1 (e.g. "each purchase is for one figure") — otherwise just leave stock count out of the description entirely.`
      : `Quantity available: ${item.quantity}`;

  const breakdown = normalizeBreakdown(item.expirationBreakdown);
  const expirationNote = breakdown
    ? `Expiration dates: the units in this listing don't all share one date (${describeBreakdown(breakdown)}). The full list of dates with unit counts is added to the end of the description automatically, so don't list them yourself; just say plainly that the units have different expiration dates and the earliest is ${formatExpiration(breakdown[0].date)}. If it fits in the title (see the title rules), use that earliest date there, as the full MM/DD/YYYY.`
    : item.expirationDate
    ? `Expiration date: ${item.expirationDate.toISOString().slice(0, 10)} — state this plainly in the description so the buyer knows exactly what they're getting (e.g. "Best by MM/DD/YYYY"). If it fits in the title (see the title rules), use the same full MM/DD/YYYY date there too, not just the month and year (eBay pulled a real listing over the title/specifics only showing month/year while the description had the full date).`
    : "";

  // A customer return listed again in its real condition (Returns mode,
  // src/lib/warehouse/returns.ts): what staff found wrong with it, so the
  // description says so. null for everything else.
  const returnNote = await returnDraftNote(item.id);

  // No UPC but picked off the manifest by name or Item # (2026-10-25):
  // the supplier's description says what it is.
  const manifestLine =
    !item.upc && item.manifestLineId
      ? await prisma.manifestLine.findUnique({ where: { id: item.manifestLineId }, select: { description: true, supplierSku: true } })
      : null;
  const upcNote = item.upc
    ? `UPC: ${item.upc}\nUPC lookup data (may be incomplete or missing): ${JSON.stringify(upcLookupData)}`
    : manifestLine
      ? `No UPC. The supplier's manifest lists this product as: "${manifestLine.description}"${manifestLine.supplierSku ? ` (supplier Item # ${manifestLine.supplierSku})` : ""}. Use that and the photos to identify it. Don't put the supplier's Item # in the title.`
      : "No UPC — this is a custom/handmade item with no barcode. Draft from the photo and the details below.";

  // Each is resized to 1568px before sending (src/lib/anthropic.ts), so 8
  // stays well under the request size limit.
  const photos = item.photoUrls.slice(0, MAX_DRAFT_PHOTOS);

  const promptText = `Draft an eBay listing title and description for this product.

${upcNote}
${quantityNote}
${packNote}
Condition: ${item.condition ?? "not specified yet (set by hand in review)"}
${expirationNote}
${returnNote ? `\n${returnNote}\n` : ""}
${photos.length > 1 ? `\nThere are ${photos.length} photos of this exact item. The first is the main shot; the others are usually taken to show condition (a dented box, a torn seal, scuffs, wear) or other sides of the package (ingredients, count, size). Use details from all of them, and if any shows a flaw, say so plainly in the description so the buyer isn't surprised.\n` : ""}
Write an eBay title buyers will find (80 characters max) and a short, honest description a buyer would find helpful. Do not invent specifics (model numbers, exact materials) that aren't supported by the UPC data or the photos.

${TITLE_RULES}

Lay the description out as plain text in this shape (no HTML, no markdown like ** or #; it's turned into headings and bullet lists for eBay):
One or two sentences saying exactly what the buyer gets (how many, what it is).

What's included:
- one short line per thing in the box or lot (counts, pack sizes, totals)

Details:
- only facts the package or lookup data supports: brand, model or REF number, size, count, expiration date, lot number, where it's made

Condition:
- plainly what the photos show: seals, shrink-wrap, shelf wear, any flaw

Keep every bullet short (one fact each), skip a section if there's nothing true to put in it, and leave a blank line between sections. Don't add a shipping or returns section; the listing adds that itself.

Describe the item's state the way a seller who has it in hand would: state what the photos clearly show as plain fact ("The caps are still shrink-wrapped."), and leave out anything the photos can't confirm. Never hedge with "appears", "seems" or "looks like": it reads as if the seller never checked their own item.`;

  // Every photo, not just the first: the extra ones are usually condition
  // shots (Cristian, 2026-10-15), and a dent or torn seal belongs in the
  // description. Images go first, in order, then the prompt.
  const photoBlocks = await Promise.all(photos.map(imageContentBlock));
  const content: Anthropic.Messages.ContentBlockParam[] = [
    ...photoBlocks.filter((b): b is Anthropic.Messages.ContentBlockParam => b != null),
    { type: "text", text: promptText },
  ];

  // No web search here (just vision + structured output), so this should be
  // fast — but bound it anyway so a hung request can't eat the whole
  // background job's time budget and starve the category lookup after it.
  const response = await anthropic.messages.create(
    {
      model: "claude-opus-5-5",
      // Was 1024. Drafts grew (every photo, Rx check, sectioned
      // description) to ~800 tokens on average, and some hit 1024 and got
      // cut off mid-JSON, so the parse failed and the item sat with no
      // draft or category (2026-10-26). Billed by tokens used, not this cap.
      max_tokens: 4096,
      output_config: { format: { type: "json_schema", schema: DRAFT_SCHEMA } },
      messages: [{ role: "user", content }],
    },
    // maxRetries: 0 — the SDK retries timeouts by default, which multiplies
    // wall-clock time up to timeout * (retries + 1). We want 45s to actually
    // mean 45s, not up to 135s.
    { timeout: 45_000, maxRetries: 0 }
  );
  await logAiUsage("draft.item", response, { itemId });
  if (response.stop_reason === "max_tokens") throw new Error("AI draft was cut off (hit max_tokens)");

  const textBlock = response.content.find((b) => b.type === "text");
  const draft = JSON.parse(
    textBlock && "text" in textBlock ? textBlock.text : "{}"
  ) as Draft;

  // Every date with its unit count, as one more plain-text section (laid
  // out with the rest by listingDescription.ts). An HTML draft (shouldn't
  // happen any more) keeps the HTML list.
  if (breakdown && draft.description) {
    draft.description = /<[a-z][^>]*>/i.test(draft.description)
      ? draft.description + breakdownDescriptionHtml(breakdown)
      : `${draft.description.trimEnd()}\n\n${breakdownDescriptionText(breakdown)}`;
  }

  const countPerPackage =
    Number.isInteger(draft.countPerPackage) && draft.countPerPackage! >= 1 ? draft.countPerPackage! : null;
  // "Not Rx only" pressed on the Review page sticks through a regenerate.
  const rxCleared = item.rxOnly === false && Boolean(item.rxOnlyNote?.startsWith("Cleared"));
  const rx = rxCleared
    ? {}
    : { rxOnly: draft.rxOnly === true, rxOnlyNote: draft.rxOnly === true ? (draft.rxOnlyNote?.slice(0, 300) ?? "Rx Only on the package") : null };
  return await applyDraft(item, draft, { ...(upcLookupData ? { upcLookupData } : {}), countPerPackage, ...rx });
}

const RETITLE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string", description: "The new eBay title, 80 characters or fewer" } },
  required: ["title"],
  additionalProperties: false,
} as const;

// A new title for a listing that's already written, by the title rules
// above (the live-listing tune-up, scripts/optimize-live-listings.ts).
// Text only: the old title, specifics and description already hold what
// the photos showed, and every fact has to come from them. Returns the
// title without saving it.
export async function retitleItem(item: Item, extraSpecifics: Record<string, string> = {}): Promise<string> {
  const specifics = { ...extraSpecifics, ...((item.itemSpecifics as Record<string, string> | null) ?? {}) };
  const specificsText = Object.entries(specifics)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const breakdown = normalizeBreakdown(item.expirationBreakdown);
  const expiration = breakdown
    ? `Units have different expiration dates; the earliest is ${formatExpiration(breakdown[0].date)}.`
    : item.expirationDate
      ? `Expiration date: ${formatExpiration(item.expirationDate.toISOString().slice(0, 10))}`
      : "No expiration date.";
  const prompt = `Rewrite this eBay listing's title so more of the buyers searching for it find it.

Current title: ${item.finalTitle}
${item.isMultipack ? `This is a multi-pack of ${item.packSize} units.` : "This is a single unit, not a multi-pack."}
${expiration}
${specificsText ? `\nItem specifics:\n${specificsText}\n` : ""}${item.finalDescription ? `\nDescription:\n${item.finalDescription.slice(0, 1500)}\n` : ""}
Keep every fact the current title gets right (pack count, size, count, model or REF number). Don't add a fact that isn't in the title, the item specifics or the description. If the current title already follows the rules, return it unchanged.

${TITLE_RULES}`;

  // Over 80 gets one more try, told its length: cutting it to fit drops
  // whatever came last, which was a real fact ("2 Boxes of" with the 5 cut
  // off, in the first sample run).
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await anthropic.messages.create(
      {
        model: "claude-opus-5-5",
        // 512 cut half the first sample run off mid-answer.
        max_tokens: 2048,
        output_config: { effort: "low", format: { type: "json_schema", schema: RETITLE_SCHEMA } },
        messages: [{ role: "user", content: prompt + feedback }],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    await logAiUsage("draft.retitle", response, { itemId: item.id });
    if (response.stop_reason === "max_tokens") throw new Error("Retitle was cut off (hit max_tokens)");
    const textBlock = response.content.find((b) => b.type === "text");
    const { title } = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}") as { title?: string };
    const clean = removeBlockedPhrases(title?.trim() ?? "", await getBlockedPhrases()).trim();
    if (!clean) throw new Error("Retitle came back empty");
    if (clean.length <= 80) return clean;
    feedback = `\n\nYour last title was ${clean.length} characters: "${clean}". Give one of 80 or fewer that keeps every fact, by dropping the least searched words.`;
  }
  // Still too long twice: keep the title that's live.
  return item.finalTitle ?? "";
}

type BundleComponent = {
  upc: string;
  quantity: number;
  photoUrls?: string[] | null;
  name?: string | null;
  upcLookupData?: unknown;
  expirationDate?: string | null;
  // A flaw this component's photos show ("box corner crushed"), written
  // onto its line in the description. null when none is visible.
  conditionNote?: string | null;
};

const COMPONENT_NAME_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "A short, clear, buyer-facing product name for this item (e.g. 'Silicone Whisk', 'Vanilla Bean Candle 8oz'), based on its photos and UPC lookup data. Never a generic placeholder like 'Item 1'.",
    },
    conditionNote: {
      type: ["string", "null"],
      description: "A short, plain note of any flaw the photos clearly show on this item or its packaging (e.g. 'Box corner crushed', 'Outer seal torn, inner seal intact', 'Scuffs on the lid'). Stated as fact, no 'appears' or 'seems'. null if the photos show no flaw.",
    },
  },
  required: ["name", "conditionNote"],
  additionalProperties: false,
} as const;

const BUNDLE_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "eBay listing title for the whole bundle, 80 characters or fewer. Make clear it's a bundle/lot of multiple items and roughly how many pieces.",
    },
    introDescription: {
      type: "string",
      description: "A short intro paragraph (2-4 sentences) describing the bundle as a whole and its general appeal/theme. Do NOT list the individual items or their quantities here — an itemized list of exactly what's included gets appended automatically after this, from known data, so don't duplicate or guess at it.",
    },
    specifics: SPECIFICS_SCHEMA,
  },
  required: ["title", "introDescription", "specifics"],
  additionalProperties: false,
} as const;

// One item's photo + UPC data at a time, never bundled together with other
// photos — keeps every request small and safe no matter how many items are
// in the bundle (a real upload hit Anthropic's 413 request_too_large trying
// to send every component's photo in one request).
async function nameComponent(c: BundleComponent): Promise<{ name: string; conditionNote: string | null }> {
  const fallback = { name: `item (UPC ${c.upc})`, conditionNote: null };
  const photos = (c.photoUrls ?? []).slice(0, MAX_COMPONENT_PHOTOS);
  const content: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: "text",
      text: `What is this product? UPC: ${c.upc}. UPC lookup data (may be incomplete or missing): ${JSON.stringify(c.upcLookupData)}

Give a short, clear, buyer-facing product name.${photos.length > 1 ? ` There are ${photos.length} photos of this one item: other sides of the package, or close-ups taken to show its condition. Use all of them, and note any flaw they show.` : ""}`,
    },
  ];
  // Every photo of this component, not just the first: extra ones are
  // often condition shots (Cristian, 2026-10-15). Still one component per
  // request, so a big bundle can't hit the 413 above.
  const photoBlocks = await Promise.all(photos.map(imageContentBlock));
  content.unshift(...photoBlocks.filter((b): b is Anthropic.Messages.ContentBlockParam => b != null));

  try {
    const response = await anthropic.messages.create(
      {
        // Simple "what is this product" identification from one photo,
        // called once per bundle component — high-volume and low-stakes
        // (a bad name is easy for the reviewer to fix), so Haiku is plenty.
        model: "claude-haiku-4-5",
        max_tokens: 256,
        output_config: { format: { type: "json_schema", schema: COMPONENT_NAME_SCHEMA } },
        messages: [{ role: "user", content }],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    await logAiUsage("draft.bundle_component", response);
    const textBlock = response.content.find((b) => b.type === "text");
    const parsed = JSON.parse(
      textBlock && "text" in textBlock ? textBlock.text : "{}"
    ) as { name?: string; conditionNote?: string | null };
    return { name: parsed.name || fallback.name, conditionNote: parsed.conditionNote?.trim() || null };
  } catch (e) {
    console.error(`[draftBundleItem] naming component UPC ${c.upc} failed`, e);
    return fallback;
  }
}

// Bundles combine several *different* products into one listing. eBay
// doesn't allow "mystery box" listings — everything inside has to be
// individually disclosed — so the manifest (what's included and how many of
// each) is built deterministically by this code from the known component
// data, never left for the model to recount or summarize in free text.
//
// Drafting happens in two stages: first, each component is named from its
// own photo in its own small request (see nameComponent above); then one
// final text-only call (plus the hero photo) writes the title and intro
// paragraph for the bundle as a whole, from the now-known item names.
async function draftBundleItem(item: Item) {
  const components = ((item.bundleComponents as unknown as BundleComponent[] | null) ?? []).slice();

  await Promise.all(
    components.map(async (c) => {
      if (c.upcLookupData) return;
      try {
        c.upcLookupData = await lookupUpc(c.upc);
      } catch {
        c.upcLookupData = { error: "UPC lookup failed" };
      }
    })
  );

  await Promise.all(
    components.map(async (c) => {
      const named = await nameComponent(c);
      c.name = named.name;
      c.conditionNote = named.conditionNote;
    })
  );

  const manifestForPrompt = components
    .map((c, i) => `${i + 1}. ${c.quantity}x ${c.name}${c.expirationDate ? ` (expires ${formatExpiration(c.expirationDate)})` : ""}${c.conditionNote ? ` [condition: ${c.conditionNote}]` : ""}`)
    .join("\n");
  const anyExpiring = components.some((c) => c.expirationDate);
  const anyFlawed = components.some((c) => c.conditionNote);

  const content: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: "text",
      text: `Write an eBay listing title and short intro description for a BUNDLE of ${components.length} different items sold together as one lot.

${item.quantity} bundle(s) available for sale (each identical, containing all the items below).
${anyFlawed ? "Note: some items have a condition note (shown below). Mention briefly in the intro that condition details are listed per item, without restating them (they're added to the item list automatically).\n" : ""}${anyExpiring ? "Note: one or more items in this bundle have an expiration date (shown below) — mention plainly in the intro that some contents have expiration dates, without needing to restate each one (the exact dates are listed automatically per item afterward)." : ""}

Contents:
${manifestForPrompt}

Write a title (80 characters max) and a short intro paragraph (2-4 sentences) describing the bundle as a whole and its general appeal. Do not list the individual items/quantities yourself — an itemized list gets appended automatically after your intro from the data above, so don't duplicate it.`,
    },
  ];

  const heroPhoto = item.photoUrls[0];
  if (heroPhoto) {
    const block = await imageContentBlock(heroPhoto);
    if (block) content.push(block);
  }

  const response = await anthropic.messages.create(
    {
      model: "claude-opus-5-5",
      max_tokens: 4096,
      output_config: { format: { type: "json_schema", schema: BUNDLE_SUMMARY_SCHEMA } },
      messages: [{ role: "user", content }],
    },
    { timeout: 45_000, maxRetries: 0 }
  );
  await logAiUsage("draft.bundle", response, { itemId: item.id });
  if (response.stop_reason === "max_tokens") throw new Error("AI draft was cut off (hit max_tokens)");

  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(
    textBlock && "text" in textBlock ? textBlock.text : "{}"
  ) as {
    title?: string;
    introDescription?: string;
    specifics?: Record<string, string | null>;
  };

  // eBay renders Description as HTML — plain "\n" line breaks collapse into
  // one run-on paragraph on the live listing (a real bundle listing came out
  // completely bunched up). Use actual <ul>/<li>/<br> markup instead.
  const manifestListHtml = components
    .map(
      (c) =>
        `<li>${c.quantity}x ${c.name} (UPC ${c.upc})${c.expirationDate ? ` — Best by ${formatExpiration(c.expirationDate)}` : ""}${c.conditionNote ? `. Condition: ${escapeHtml(c.conditionNote)}` : ""}</li>`
    )
    .join("");
  const description = `<p>${parsed.introDescription ?? ""}</p><p>This bundle includes:</p><ul>${manifestListHtml}</ul>`;

  return await applyDraft(
    item,
    { title: parsed.title, description, specifics: parsed.specifics },
    { bundleComponents: components as unknown as Prisma.InputJsonValue }
  );
}
