import { prisma } from "@/lib/prisma";
import { getShelfState, getShelfStates } from "@/lib/warehouse/shelves";
import { NextRequest, NextResponse } from "next/server";

// Which shelves take bins yet (warehouse cutover, see shelves.ts).
//   ?label=A5 -> { shelf: ShelfState }
//   no label  -> { shelves: ShelfState[] }
export async function GET(request: NextRequest) {
  const label = request.nextUrl.searchParams.get("label")?.trim();
  if (label) {
    const shelf = await getShelfState(prisma, label);
    if (!shelf) return NextResponse.json({ error: `No shelf called "${label}".` }, { status: 404 });
    return NextResponse.json({ shelf });
  }
  return NextResponse.json({ shelves: await getShelfStates() });
}
