import { prisma } from "@/lib/prisma";
import { lookupUpc } from "@/lib/upcLookup";
import { anthropic, fetchImageAsBase64 } from "@/lib/anthropic";
import type { Prisma } from "@/generated/prisma/client";
import type Anthropic from "@anthropic-ai/sdk";

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
  },
  required: ["title", "description"],
  additionalProperties: false,
} as const;

// Looks up the item's UPC (caching the result) and asks Claude to draft an
// eBay title + description from that data plus the first product photo.
// A "Regenerate" only overwrites the reviewer-facing finalTitle/
// finalDescription if they still match the *previous* AI draft (i.e. the
// reviewer never edited them) — a manual edit is never silently clobbered.
export async function draftItem(itemId: string) {
  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });

  let upcLookupData: Prisma.InputJsonValue;
  if (item.upcLookupData) {
    upcLookupData = item.upcLookupData as Prisma.InputJsonValue;
  } else {
    try {
      upcLookupData = (await lookupUpc(item.upc)) as Prisma.InputJsonValue;
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
    try {
      const { data, mediaType } = await fetchImageAsBase64(firstPhoto);
      content.unshift({
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      });
    } catch {
      // Draft from text alone if the photo can't be fetched.
    }
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
    { timeout: 45_000 }
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const draft = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}") as {
    title?: string;
    description?: string;
  };

  const titleUnedited = !item.finalTitle || item.finalTitle === item.aiTitle;
  const descriptionUnedited =
    !item.finalDescription || item.finalDescription === item.aiDescription;

  return prisma.item.update({
    where: { id: itemId },
    data: {
      upcLookupData,
      aiTitle: draft.title ?? null,
      aiDescription: draft.description ?? null,
      finalTitle: titleUnedited ? (draft.title ?? item.finalTitle) : item.finalTitle,
      finalDescription: descriptionUnedited
        ? (draft.description ?? item.finalDescription)
        : item.finalDescription,
    },
  });
}
