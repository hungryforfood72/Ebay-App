import { prisma } from "@/lib/prisma";
import { resolveBinScan } from "@/lib/warehouse/shelves";
import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, getBinDetail } from "../shared";

// One bin: status, contents and recent moves. See getBinDetail. An
// oversized shelf's label gives that shelf (its hidden bin).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  try {
    return NextResponse.json(await getBinDetail(await resolveBinScan(prisma, code)));
  } catch (e) {
    return binsErrorResponse(e);
  }
}
