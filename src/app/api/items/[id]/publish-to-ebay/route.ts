import {
  createOffer,
  createOrReplaceInventoryItem,
  BLOCKED_WORDS_ERROR,
  EbayApiError,
  getEbayEnvironment,
  publishOffer,
  refreshOffer,
  toEbaySku,
  toItemForEbayPublish,
} from "@/lib/ebay";
import { stripKnownBlockedWords, tryAutoFix } from "@/lib/publishRemediation";
import { runFixAgent } from "@/lib/publishFixAgent";
import { NEEDS_YOU_PREFIX } from "@/lib/needsYou";
import { binGateError } from "@/lib/warehouse/binGate";
import { prisma } from "@/lib/prisma";
import { ALREADY_PUBLISHING, claimPublish, releasePublish } from "@/lib/publishLock";
import { queueShopifyPublish } from "@/lib/shopifySync";
import { forViewer } from "@/lib/itemView";
import { NextRequest, NextResponse } from "next/server";
import type { Item } from "@/generated/prisma/client";

// Auto-fixes (tryAutoFix) can each add a web-search call or a round of
// eBay verify calls on top of the real publish round-trips, up to
// MAX_AUTO_FIXES times.
export const maxDuration = 300;

// One error at a time is all eBay reports, so an item missing a specific
// AND carrying a blocked word takes two rounds.
const MAX_AUTO_FIXES = 3;

// The fix agent only starts with at least this long left of maxDuration,
// and stops itself this far short of it, so the publish after it and the
// error save still fit.
const FIX_AGENT_MIN_MS = 90_000;
const FIX_AGENT_RESERVE_MS = 40_000;

// The fix agent gave up: the reason is what the person has to do.
class NeedsYouError extends Error {}

async function attemptPublish(id: string, item: Item): Promise<{ listingId: string }> {
  const publishData = toItemForEbayPublish(item);
  // Always re-pushed, not just on the very first attempt — a retry (manual
  // edit, or the auto-fix below) that changed price/title/specifics since
  // the offer was first created needs eBay's inventory item to actually
  // reflect that before publishing again. The old "only on first attempt"
  // gate meant a fixed item specific would never actually reach eBay on
  // retry — publishOffer would just fail the exact same way a second time.
  await createOrReplaceInventoryItem(publishData);

  let offerId = item.ebayOfferId;
  if (!offerId) {
    offerId = await createOffer(publishData);
    // ebaySku is persisted here (not just computed on the fly) so a later
    // eBay order's line-item sku can be matched back to this Item via an
    // indexed exact lookup — see the field's schema comment.
    await prisma.item.update({
      where: { id },
      data: { ebayOfferId: offerId, ebaySku: toEbaySku(item.sku) },
    });
  } else {
    // Same reasoning for the offer: a category/price/description fixed in
    // Review since the failed attempt has to reach eBay too.
    await refreshOffer(offerId, publishData);
  }
  const listingId = await publishOffer(offerId);
  return { listingId };
}

// Publishes one item live via the real eBay Inventory API. Deliberately its
// own explicit action, separate from "Mark ready" — Cristian reviews every
// field by hand on the review page already; this button is the second,
// distinct decision to actually make it live, since publishOffer isn't
// cleanly undoable from inside this app.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const item = await prisma.item.findUnique({ where: { id } });
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }

  // The draft saw "Rx Only" on the package: eBay removes prescription
  // devices (Cristian, 2026-10-25), so it never goes up. "Not Rx only" on
  // the Review page clears it if the draft got it wrong.
  if (item.rxOnly) {
    return NextResponse.json(
      { error: `The package says Rx Only${item.rxOnlyNote ? ` (${item.rxOnlyNote})` : ""}, and eBay doesn't allow prescription devices. Set it aside instead.` },
      { status: 400 }
    );
  }

  // Server-side belt-and-suspenders, same reasoning as the CSV export
  // route's exportableItems filter — a past real upload failure taught the
  // team client-side gating alone isn't enough to trust.
  const missing: string[] = [];
  if (!item.finalTitle) missing.push("title");
  if (item.price == null) missing.push("price");
  if (!item.categoryId) missing.push("category");
  if (!item.condition) missing.push("condition");
  // A pickup-only item never gets a label, so no weight to give.
  if (!item.localPickupOnly && !item.weightLbs && !item.weightOz) missing.push("weight");
  if (item.photoUrls.length === 0) missing.push("at least one photo");
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing ${missing.join(", ")} before this can be published.` },
      { status: 400 }
    );
  }
  // Nothing goes live until it's binned, so no order can come in for a bag
  // still loose on the binning table (src/lib/warehouse/binGate.ts). Only a
  // first publish: an already-live listing is past this point.
  if (!item.ebayListingId) {
    const binError = await binGateError(item);
    if (binError) return NextResponse.json({ error: binError }, { status: 400 });
  }

  if (!(await claimPublish(id))) return NextResponse.json({ error: ALREADY_PUBLISHING }, { status: 409 });
  try {
    return await publish(request, id, item);
  } finally {
    await releasePublish(id);
  }
}

async function publish(request: Request, id: string, item: Item) {
  const startedAt = Date.now();
  const autoFixes: string[] = [];
  let agentRan = false;
  try {
    const preCleaned = await stripKnownBlockedWords(item);
    if (preCleaned) autoFixes.push(preCleaned);
    let current = preCleaned ? await prisma.item.findUniqueOrThrow({ where: { id } }) : item;
    let result;
    for (let round = 0; ; round++) {
      try {
        result = await attemptPublish(id, current);
        break;
      } catch (e) {
        // Fix what can be fixed without a person (a missing or rejected
        // item specific, a blocked word) and publish again. Anything else,
        // or a fix that can't find a confident answer, falls through to the
        // outer catch unchanged.
        if (round >= MAX_AUTO_FIXES + 1) throw e;
        const message = e instanceof EbayApiError || e instanceof Error ? e.message : "Publish failed.";
        let note = round < MAX_AUTO_FIXES ? await tryAutoFix(id, message) : null;
        // Nothing quick worked: the fix agent gets one go (publishFixAgent.ts).
        const endsAt = startedAt + maxDuration * 1000;
        if (!note && !agentRan && endsAt - Date.now() >= FIX_AGENT_MIN_MS) {
          agentRan = true;
          const agent = await runFixAgent(id, message, { alreadyTried: autoFixes, deadline: endsAt - FIX_AGENT_RESERVE_MS });
          if (agent && !agent.fixed) {
            autoFixes.push(...agent.notes);
            throw new NeedsYouError(agent.needsYou);
          }
          if (agent) note = `Fix agent: ${agent.notes.join(" ")}`;
        }
        if (!note) throw e;
        autoFixes.push(note);
        current = await prisma.item.findUniqueOrThrow({ where: { id } });
      }
    }
    const updated = await prisma.item.update({
      where: { id },
      data: {
        status: "listed",
        ebayListingId: result.listingId,
        ebayPublishedAt: new Date(),
        ebayPublishError: null,
        ebayEnvironment: getEbayEnvironment(),
      },
    });
    // Everything that goes live on eBay goes on Shopify too, once this
    // response is out. A failure there is saved on the item and retried by
    // the cron; it never undoes the eBay listing.
    queueShopifyPublish(id);
    return NextResponse.json(forViewer(request, { ...updated, autoFixes }));
  } catch (e) {
    const raw = e instanceof EbayApiError || e instanceof Error ? e.message : "Publish failed.";
    // Errors only a person can fix: say how, in plain words.
    let message = raw;
    let missingAspect: RegExpMatchArray | null;
    if (e instanceof NeedsYouError) {
      message = `${NEEDS_YOU_PREFIX}${e.message}`;
    } else if (/item\s+specific\s+Expiration\s+Date\s+is\s+missing/i.test(raw)) {
      message = "eBay needs the expiration date for this category. Send it back to review, add the date printed on the package, and publish again.";
    } else if ((missingAspect = raw.match(/item\s+specific\s+([A-Za-z0-9\s/&'-]+?)\s+is\s+missing/i))) {
      const name = missingAspect[1].replace(/\s+/g, " ").trim();
      // Online listings often give only two of a box's three sides
      // (confirmed live 2026-10-15: a Ziploc box is listed everywhere as
      // just 11.3"W x 2.6"H), so the last one has to come off a tape measure.
      message = /^item\s+(length|width|height)$/i.test(name)
        ? `eBay needs "${name}" for this category, and it isn't listed anywhere online. Measure the box, add a "${name}" item specific in review (exact name, like "5.5 in"), and publish again.`
        : `eBay needs "${name}" for this category, and the app couldn't find it automatically. Send it back to review, add a "${name}" item specific (exact name) with the real value, and publish again.`;
    } else if (BLOCKED_WORDS_ERROR.test(raw)) {
      message = "eBay's word filter blocked this, and the app couldn't find the words. Look for brand claims, recalled product names or medical claims in the title and description, and publish again.";
    }
    if (autoFixes.length > 0) message += ` (Already auto-fixed: ${autoFixes.join(" ")})`;
    await prisma.item.update({ where: { id }, data: { ebayPublishError: message } });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
