import { NextRequest, NextResponse } from "next/server";
import { binsErrorResponse, getBinDetail } from "../shared";

// One bin: status, contents and recent moves. See getBinDetail.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  try {
    return NextResponse.json(await getBinDetail(code));
  } catch (e) {
    return binsErrorResponse(e);
  }
}
