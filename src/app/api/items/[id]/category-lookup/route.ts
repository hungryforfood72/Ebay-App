import { prisma } from "@/lib/prisma";
import { anthropic } from "@/lib/anthropic";
import { NextResponse } from "next/server";

type LookupResult = {
  categoryId: string | null;
  categoryName: string | null;
  sourceUrl: string | null;
};

// Web search + Opus latency is unpredictable (seen anywhere from ~30s to
// several minutes). Give Vercel's function enough room for the 90s SDK
// timeout below to actually fire and return a clean error.
export const maxDuration = 100;

// Asks Claude to search the web for the real, current eBay category ID for
// this item. Uses Claude's own web_search tool (server-side, run by
// Anthropic) rather than this app scraping eBay directly.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const item = await prisma.item.findUniqueOrThrow({ where: { id } });

  const productDescription = item.finalTitle ?? item.aiTitle ?? `UPC ${item.upc}`;

  let response;
  try {
    response = await anthropic.messages.create(
      {
        model: "claude-opus-4-8",
        max_tokens: 1024,
        output_config: { effort: "low" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
        messages: [
          {
            role: "user",
            content: `Find the real, current eBay category ID for this product: "${productDescription}".

Search eBay's own site (ebay.com). The category ID is embedded in eBay's live browse/search URLs — either as the numeric segment in a "/b/Name/123456/bn_..." browse URL, or as "_sacat=123456" on a search results page. Pick the most specific matching category, not an overly broad parent category.

Once you've found it, respond with exactly one JSON object as your final line, no other text after it:
{"categoryId": "123456", "categoryName": "Category Name", "sourceUrl": "https://..."}

If you can't find a confident match, respond with:
{"categoryId": null, "categoryName": null, "sourceUrl": null}`,
          },
        ],
      },
      // Web search latency is unpredictable and occasionally hangs well past
      // what's reasonable for a button click — fail fast instead of tying up
      // the function for the default 10-minute SDK timeout.
      { timeout: 90_000 }
    );
  } catch {
    return NextResponse.json(
      { error: "Search timed out. Try again, or set the category manually." },
      { status: 504 }
    );
  }

  const textBlocks = response.content.filter(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text"
  );
  const lastText = textBlocks[textBlocks.length - 1]?.text ?? "";
  const match = lastText.match(/\{[\s\S]*\}\s*$/);

  let result: LookupResult = { categoryId: null, categoryName: null, sourceUrl: null };
  if (match) {
    try {
      result = JSON.parse(match[0]);
    } catch {
      // Fall through with the "not found" default.
    }
  }

  return NextResponse.json(result);
}
