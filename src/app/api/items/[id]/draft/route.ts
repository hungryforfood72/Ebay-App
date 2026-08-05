import { draftItem } from "@/lib/draftItem";
import { NextResponse } from "next/server";

// A bundle drafts each component in its own call (parallel) plus one final
// synthesis call — give it enough room even if several run near their
// individual timeouts.
export const maxDuration = 90;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const updated = await draftItem(id);
    return NextResponse.json(updated);
  } catch (e) {
    console.error(`[draft route] ${id}: unhandled error`, e);
    return NextResponse.json(
      { error: "Draft generation failed unexpectedly. Try again." },
      { status: 500 }
    );
  }
}
