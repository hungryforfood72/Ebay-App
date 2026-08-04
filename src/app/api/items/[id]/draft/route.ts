import { draftItem } from "@/lib/draftItem";
import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const updated = await draftItem(id);
  return NextResponse.json(updated);
}
