import { ownerOnly } from "@/lib/auth";
import { exportBackup } from "@/lib/listingBackup";
import { NextRequest, NextResponse } from "next/server";

// Every live listing in the backup as one JSON file, to keep somewhere off
// the app too.
export async function GET(request: NextRequest) {
  const denied = ownerOnly(request);
  if (denied) return denied;
  const listings = await exportBackup();
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify({ exportedAt: new Date().toISOString(), count: listings.length, listings }, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="ebay-listings-backup-${date}.json"`,
    },
  });
}
