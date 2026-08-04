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
  const result = await lookupCategoryForItem(id);

  if (!result.categoryId) {
    return NextResponse.json(
      { error: "Couldn't find a confident match." },
      { status: 404 }
    );
  }

  return NextResponse.json(result);
}
