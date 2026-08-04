import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

const EDITABLE_FIELDS = [
  "finalTitle",
  "finalDescription",
  "price",
  "categoryId",
  "condition",
  "compNotes",
  "status",
  "reviewedBy",
] as const;

// Update review-step fields on an item (title/description/price/status, etc).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  const data: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in body) data[field] = body[field];
  }
  if ("status" in data && data.status === "ready") {
    data.reviewedAt = new Date();
  }

  const item = await prisma.item.update({ where: { id }, data });

  return NextResponse.json(item);
}

// Delete an item (e.g. a scan mistake or duplicate). Only removes the
// database record — any Cloudinary photos it referenced are left as-is.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.item.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
