import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// Local search over eBay's own category tree (imported from their official
// category export — see references/ebay-category-ids.md). Instant and free,
// so this is always tried before ever falling back to an AI web search.
export async function GET(request: NextRequest) {
  // Exact-ID lookup — used to validate a category ID typed by hand into the
  // review page's free-text field, since that field has no dropdown to
  // constrain it to a real category.
  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (id) {
    const category = await prisma.ebayCategory.findUnique({ where: { id } });
    return NextResponse.json(category);
  }

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
