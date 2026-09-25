import { ownerOnly } from "@/lib/auth";
import { shelfValue } from "@/lib/shelfValue";
import { NextResponse } from "next/server";

// Owner only: what the stock on the shelf cost (see src/lib/shelfValue.ts).
export async function GET(request: Request) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  return NextResponse.json(await shelfValue());
}
