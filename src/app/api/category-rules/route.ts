import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

// All saved keyword -> eBay category mappings, for the review page to match
// against item titles.
export async function GET() {
  const rules = await prisma.categoryRule.findMany({
    orderBy: { keyword: "asc" },
  });
  return NextResponse.json(rules);
}

// Save a new keyword -> category mapping (or update the existing one for
// that keyword) so future items with a matching title auto-suggest it.
export async function POST(request: NextRequest) {
  const body = await request.json();
  const keyword = String(body.keyword ?? "").trim().toLowerCase();
  const categoryId = String(body.categoryId ?? "").trim();
  const categoryName = String(body.categoryName ?? "").trim();

  if (!keyword || !categoryId) {
    return NextResponse.json(
      { error: "keyword and categoryId are required" },
      { status: 400 }
    );
  }

  const rule = await prisma.categoryRule.upsert({
    where: { keyword },
    create: { keyword, categoryId, categoryName: categoryName || keyword },
    update: { categoryId, categoryName: categoryName || keyword },
  });

  return NextResponse.json(rule, { status: 201 });
}
