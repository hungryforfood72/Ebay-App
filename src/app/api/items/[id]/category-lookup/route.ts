import { lookupCategoryForItem } from "@/lib/categoryLookup";
import { fillCategorySpecifics } from "@/lib/categorySpecifics";
import { after, NextResponse } from "next/server";

// Give Vercel's function enough room for the full worst-case chain in
// lookupCategoryForItem: local pick (20s) + generic-terms (15s) +
// broadened local pick (20s) + web search fallback (35s) = 90s max, all with
// maxRetries: 0 so each SDK timeout can't multiply. Plus the category
// specifics fill after it (up to 40s).
export const maxDuration = 140;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Catch everything, not just the Claude call — an uncaught throw anywhere
  // in here (a bad DB read, whatever) renders Next's default HTML error
  // page instead of JSON, which breaks the client's res.json(). Always
  // return valid JSON from this route, no exceptions.
  try {
    const result = await lookupCategoryForItem(id);

    if (!result.categoryId) {
      return NextResponse.json(
        { error: "Couldn't find a confident match." },
        { status: 404 }
      );
    }

    // A new category can recommend different specifics. After the
    // response, like the items route, so the button isn't held up.
    after(async () => {
      try {
        await fillCategorySpecifics(id);
      } catch (e) {
        console.error(`[category-lookup route] ${id}: category specifics failed`, e);
      }
    });

    return NextResponse.json(result);
  } catch (e) {
    console.error(`[category-lookup route] ${id}: unhandled error`, e);
    return NextResponse.json(
      { error: "Search failed unexpectedly. Try again." },
      { status: 500 }
    );
  }
}
