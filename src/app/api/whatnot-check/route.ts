import { logActivity } from "@/lib/activityLog";
import { requireOwner, requireUser } from "@/lib/auth";
import { isEbaySkipReason } from "@/lib/ebaySkips";
import { prisma } from "@/lib/prisma";
import { WarehouseError } from "@/lib/warehouse/bins";
import { errorResponse } from "@/lib/warehouse/stations";
import { checkWhatnot, overrideWhatnot, recordWhatnotDonation } from "@/lib/whatnotPolicy";
import { NextRequest, NextResponse } from "next/server";

// The List page's Whatnot check (src/lib/whatnotPolicy.ts), run before a
// Whatnot-only listing is made. Codes come from the scanner (a UPC, or a
// manifest line key for a product picked by name).
// Item #s can hold spaces and punctuation; printable text only.
const CODE = /^[ -~]{1,120}$/;

function readCode(raw: unknown): string {
  const code = typeof raw === "string" ? raw.trim() : "";
  if (!CODE.test(code)) throw new WarehouseError("Scan the product first.");
  return code;
}

async function readManifest(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string" || !raw) return null;
  const m = await prisma.manifest.findUnique({ where: { id: raw }, select: { id: true } });
  return m?.id ?? null;
}

// GET ?code=&manifestId= -> { allowed, reason, name }
export async function GET(request: NextRequest) {
  try {
    requireUser(request);
    const params = request.nextUrl.searchParams;
    const code = readCode(params.get("code"));
    return NextResponse.json(await checkWhatnot(code, await readManifest(params.get("manifestId"))));
  } catch (e) {
    return errorResponse(e);
  }
}

// POST { action: "donate", code, manifestId, quantity, reason, why? }:
//   set aside for donation, recorded against the load.
// POST { action: "allow", code, manifestId? }: Cristian overrules a block.
export async function POST(request: NextRequest) {
  try {
    const user = requireUser(request);
    const body = (await request.json().catch(() => null)) ?? {};
    if (body.action === "allow") requireOwner(request);
    const code = readCode(body.code);
    const manifestId = await readManifest(body.manifestId);

    if (body.action === "allow") {
      await overrideWhatnot(code, manifestId, user.username);
      await logActivity(
        { request },
        { action: "whatnot.allow", summary: `Marked ${code} as allowed on Whatnot`, targetType: "upc", targetId: code }
      );
      return NextResponse.json({ ok: true });
    }

    if (body.action === "donate") {
      if (!manifestId) throw new WarehouseError("Pick the load first, so the donation is counted against it.");
      // The stored reason is the server's own call, not the page's text.
      const verdict = await checkWhatnot(code, manifestId);
      const reason = verdict.allowed ? "its date is too close for a Whatnot show" : (verdict.reason ?? "Whatnot doesn't allow it");
      const quantity = Number(body.quantity);
      await recordWhatnotDonation({
        code,
        manifestId,
        quantity,
        reason,
        why: isEbaySkipReason(body.why) ? body.why : null,
        by: user.username,
      });
      await logActivity(
        { request },
        {
          action: "whatnot.donate",
          summary: `Set aside ${quantity} of ${verdict.name} for donation (not allowed on Whatnot: ${reason})`,
          targetType: "upc",
          targetId: code,
        }
      );
      return NextResponse.json({ ok: true }, { status: 201 });
    }

    throw new WarehouseError('action must be "donate" or "allow".');
  } catch (e) {
    return errorResponse(e);
  }
}
