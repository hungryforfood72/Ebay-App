import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Local search over eBay's own category tree (imported from their official
// category export — see references/ebay-category-ids.md). Instant and free,
// so this is always tried before ever falling back to an AI web search.
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json([]);

  const results = await prisma.ebayCategory.findMany({
    where: { OR: [{ name: { contains: q, mode: "insensitive" } }, { path: { contains: q, mode: "insensitive" } }] },
    take: 25,
  });

  // Prefer matches where the leaf category name itself contains the term
  // (not just some ancestor in the path), and shorter names (more specific,
  // less noisy) first.
  const qLower = q.toLowerCase();
  results.sort((a, b) => {
    const aNameMatch = a.name.toLowerCase().includes(qLower) ? 0 : 1;
    const bNameMatch = b.name.toLowerCase().includes(qLower) ? 0 : 1;
    if (aNameMatch !== bNameMatch) return aNameMatch - bNameMatch;
    return a.name.length - b.name.length;
  });

  return NextResponse.json(results);
}
