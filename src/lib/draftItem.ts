import { prisma } from "@/lib/prisma";
import { lookupUpc } from "@/lib/upcLookup";
import { anthropic, fetchImageAsBase64 } from "@/lib/anthropic";
import { truncateTitle } from "@/lib/ebayTitle";
import type { Item, Prisma } from "@/generated/prisma/client";
import type Anthropic from "@anthropic-ai/sdk";

const SPECIFICS_SCHEMA = {
  type: "object",
  description: "eBay item specifics. Use null for anything not confidently known from the photo or UPC data — never guess.",
  properties: {
    brand: { type: ["string", "null"], description: "Brand name, or null if not identifiable. For a bundle of different brands, use 'Various' or the dominant brand." },
    type: { type: ["string", "null"], description: "Product type, e.g. 'Sticker', 'Hair Dye', 'Action Figure'. For a bundle, something like 'Bundle' or 'Lot'." },
    product: {
      type: ["string", "null"],
      description: "A short, generic name for what this product actually is, for eBay's 'Product' item specific (required by some categories) — e.g. 'Vitamin C Drops', 'Air Freshener Refill'. Usually close to type but phrased as a plain product name rather than a category label.",
    },
    color: { type: ["string", "null"], description: "Primary color, or null if not visually clear" },
    size: { type: ["string", "null"], description: "Size (clothing size, dimensions, count, etc.), or null" },
    material: { type: ["string", "null"], description: "Material, or null if not identifiable" },
  },
  required: ["brand", "type", "product", "color", "size", "material"],
  additionalProperties: false,
} as const;

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "eBay listing title, 80 characters or fewer",
    },
    description: {
      type: "string",
      description: "eBay listing description, a few sentences",
    },
    specifics: SPECIFICS_SCHEMA,
  },
  required: ["title", "description", "specifics"],
  additionalProperties: false,
} as const;

type Draft = {
  title?: string;
  description?: string;
  specifics?: Record<string, string | null>;
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
  const draftTitle = draft.title ? truncateTitle(draft.title) : draft.title;

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

// Looks up the item's UPC (caching the result) and asks Claude to draft an
// eBay title + description from that data plus the first product photo.
export async function draftItem(itemId: string) {
  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });

  if (item.isBundle) return draftBundleItem(item);

  let upcLookupData: Prisma.InputJsonValue;
  if (item.upcLookupData) {
    upcLookupData = item.upcLookupData as Prisma.InputJsonValue;
  } else {
    try {
      upcLookupData = (await lookupUpc(item.upc!)) as Prisma.InputJsonValue;
    } catch {
      upcLookupData = { error: "UPC lookup failed" };
    }
  }

  const packNote = item.isMultipack
    ? `This is a multi-pack of ${item.packSize} units — reflect that in the title and description.`
    : "This is a single unit, not a multi-pack.";

  const expirationNote = item.expirationDate
    ? `Expiration date: ${item.expirationDate.toISOString().slice(0, 10)} — state this plainly in the description so the buyer knows exactly what they're getting (e.g. "Best by MM/DD/YYYY"). Work it into the title too if there's room within the character limit.`
    : "";

  const promptText = `Draft an eBay listing title and description for this product.

UPC: ${item.upc}
UPC lookup data (may be incomplete or missing): ${JSON.stringify(upcLookupData)}
Quantity available: ${item.quantity}
${packNote}
Condition: ${item.condition ?? "not specified — infer from the photo if possible, otherwise write neutrally"}
${expirationNote}

Write a clear, keyword-appropriate eBay title (80 characters max) and a short, honest description a buyer would find helpful. Do not invent specifics (model numbers, exact materials) that aren't supported by the UPC data or the photo.`;

  const content: Anthropic.Messages.ContentBlockParam[] = [
    { type: "text", text: promptText },
  ];

  const firstPhoto = item.photoUrls[0];
  if (firstPhoto) {
    const block = await imageContentBlock(firstPhoto);
    if (block) content.unshift(block);
  }

  // No web search here (just vision + structured output), so this should be
  // fast — but bound it anyway so a hung request can't eat the whole
  // background job's time budget and starve the category lookup after it.
  const response = await anthropic.messages.create(
    {
      model: "claude-opus-4-8",
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: DRAFT_SCHEMA } },
      messages: [{ role: "user", content }],
    },
    // maxRetries: 0 — the SDK retries timeouts by default, which multiplies
    // wall-clock time up to timeout * (retries + 1). We want 45s to actually
    // mean 45s, not up to 135s.
    { timeout: 45_000, maxRetries: 0 }
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const draft = JSON.parse(
    textBlock && "text" in textBlock ? textBlock.text : "{}"
  ) as Draft;

  return applyDraft(item, draft, { upcLookupData });
}

type BundleComponent = {
  upc: string;
  quantity: number;
  photoUrl?: string | null;
  name?: string | null;
  upcLookupData?: unknown;
  expirationDate?: string | null;
};

// "12/2026" from an ISO date string — expiration on packaging is usually
// month/year, and this is what shows up in the manifest per item.
function formatExpiration(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

const COMPONENT_NAME_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "A short, clear, buyer-facing product name for this item (e.g. 'Silicone Whisk', 'Vanilla Bean Candle 8oz'), based on its photo and UPC lookup data. Never a generic placeholder like 'Item 1'.",
    },
  },
  required: ["name"],
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
async function nameComponent(c: BundleComponent): Promise<string> {
  const fallback = `item (UPC ${c.upc})`;
  const content: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: "text",
      text: `What is this product? UPC: ${c.upc}. UPC lookup data (may be incomplete or missing): ${JSON.stringify(c.upcLookupData)}

Give a short, clear, buyer-facing product name.`,
    },
  ];
  if (c.photoUrl) {
    const block = await imageContentBlock(c.photoUrl);
    if (block) content.unshift(block);
  }

  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-opus-4-8",
        max_tokens: 256,
        output_config: { format: { type: "json_schema", schema: COMPONENT_NAME_SCHEMA } },
        messages: [{ role: "user", content }],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    const textBlock = response.content.find((b) => b.type === "text");
    const parsed = JSON.parse(
      textBlock && "text" in textBlock ? textBlock.text : "{}"
    ) as { name?: string };
    return parsed.name || fallback;
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
      c.name = await nameComponent(c);
    })
  );

  const manifestForPrompt = components
    .map((c, i) => `${i + 1}. ${c.quantity}x ${c.name}${c.expirationDate ? ` (expires ${formatExpiration(c.expirationDate)})` : ""}`)
    .join("\n");
  const anyExpiring = components.some((c) => c.expirationDate);

  const content: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: "text",
      text: `Write an eBay listing title and short intro description for a BUNDLE of ${components.length} different items sold together as one lot.

${item.quantity} bundle(s) available for sale (each identical, containing all the items below).
${anyExpiring ? "Note: one or more items in this bundle have an expiration date (shown below) — mention plainly in the intro that some contents have expiration dates, without needing to restate each one (the exact dates are listed automatically per item afterward)." : ""}

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
      model: "claude-opus-4-8",
      max_tokens: 1024,
      output_config: { format: { type: "json_schema", schema: BUNDLE_SUMMARY_SCHEMA } },
      messages: [{ role: "user", content }],
    },
    { timeout: 45_000, maxRetries: 0 }
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(
    textBlock && "text" in textBlock ? textBlock.text : "{}"
  ) as {
    title?: string;
    introDescription?: string;
    specifics?: Record<string, string | null>;
  };

  const manifestLines = components
    .map((c) => `• ${c.quantity}x ${c.name}${c.expirationDate ? ` — Best by ${formatExpiration(c.expirationDate)}` : ""}`)
    .join("\n");
  const description = `${parsed.introDescription ?? ""}\n\nThis bundle includes:\n${manifestLines}`.trim();

  return applyDraft(
    item,
    { title: parsed.title, description, specifics: parsed.specifics },
    { bundleComponents: components as unknown as Prisma.InputJsonValue }
  );
}
