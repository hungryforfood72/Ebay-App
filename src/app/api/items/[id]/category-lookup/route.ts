import { lookupCategoryForItem } from "@/lib/categoryLookup";
import { NextResponse } from "next/server";

// Give Vercel's function enough room for the 35s SDK timeout in
// lookupCategoryForItem to actually fire and return a clean error.
export const maxDuration = 55;

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

    return NextResponse.json(result);
  } catch (e) {
    console.error(`[category-lookup route] ${id}: unhandled error`, e);
    return NextResponse.json(
      { error: "Search failed unexpectedly. Try again." },
      { status: 500 }
    );
  }
}
