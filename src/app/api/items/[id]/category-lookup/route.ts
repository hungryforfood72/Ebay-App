import { lookupCategoryForItem } from "@/lib/categoryLookup";
import { NextResponse } from "next/server";

// Web search + Opus latency is unpredictable (seen anywhere from ~30s to
// several minutes). Give Vercel's function enough room for the 90s SDK
// timeout in lookupCategoryForItem to actually fire and return a clean error.
export const maxDuration = 100;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await lookupCategoryForItem(id);

  if (!result.categoryId) {
    return NextResponse.json(
      { error: "Couldn't find a confident match." },
      { status: 404 }
    );
  }

  return NextResponse.json(result);
}
