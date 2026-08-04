import { prisma } from "@/lib/prisma";
import { lookupUpc } from "@/lib/upcLookup";
import { anthropic, fetchImageAsBase64 } from "@/lib/anthropic";
import { NextResponse } from "next/server";
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
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const item = await prisma.item.findUniqueOrThrow({ where: { id } });

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

  const response = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    output_config: { format: { type: "json_schema", schema: DRAFT_SCHEMA } },
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const draft = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}") as {
    title?: string;
    description?: string;
  };

  const updated = await prisma.item.update({
    where: { id },
    data: {
      upcLookupData,
      aiTitle: draft.title ?? null,
      aiDescription: draft.description ?? null,
      finalTitle: item.finalTitle ?? draft.title ?? null,
      finalDescription: item.finalDescription ?? draft.description ?? null,
    },
  });

  return NextResponse.json(updated);
}
