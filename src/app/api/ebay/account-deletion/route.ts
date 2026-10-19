import { verifyNotificationSignature } from "@/lib/ebayNotifications";
import { deleteEbayUserData } from "@/lib/warehouse/shippingLabels";
import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";

// eBay's Marketplace Account Deletion notices (required for API access;
// set up under Alerts & Notifications on the eBay developer portal). eBay
// sends one for every closed eBay account, not just our buyers, so most
// match nothing here. Signed-out by design (proxy.ts): eBay's signature is
// the gate. Nothing about the notice is stored.
//
// Setup (Cristian does the secret himself):
//   EBAY_ACCOUNT_DELETION_TOKEN  32-80 letters, digits, _ or -; the same
//                                value goes in eBay's "Verification token".
//   EBAY_ACCOUNT_DELETION_ENDPOINT  optional: the exact URL entered on eBay,
//                                if it isn't this deployment's own address.

function endpointUrl(request: NextRequest): string {
  return process.env.EBAY_ACCOUNT_DELETION_ENDPOINT || `${request.nextUrl.origin}${request.nextUrl.pathname}`;
}

// eBay's endpoint check when the URL is saved: sha256(challenge + token +
// endpoint), hex.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("challenge_code");
  const token = process.env.EBAY_ACCOUNT_DELETION_TOKEN;
  if (!code) return NextResponse.json({ error: "Missing challenge_code." }, { status: 400 });
  if (!token) return NextResponse.json({ error: "Account deletion isn't set up." }, { status: 404 });
  const challengeResponse = createHash("sha256").update(code).update(token).update(endpointUrl(request)).digest("hex");
  return NextResponse.json({ challengeResponse });
}

export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (!(await verifyNotificationSignature(raw, request.headers.get("x-ebay-signature")))) {
    // eBay's docs: 412 = the payload failed verification.
    return new NextResponse(null, { status: 412 });
  }
  let username: string | null = null;
  try {
    const body = JSON.parse(raw) as { notification?: { data?: { username?: string } } };
    username = body.notification?.data?.username?.trim() || null;
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (username) {
    const deleted = await deleteEbayUserData(username);
    if (deleted > 0) console.log(`[account-deletion] removed ${deleted} shipping label(s) for a closed eBay account`);
  }
  return new NextResponse(null, { status: 204 });
}
