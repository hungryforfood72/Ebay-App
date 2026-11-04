import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, fetchImageAsBase64 } from "@/lib/anthropic";
import { logAiUsage } from "@/lib/aiUsage";
import { logActivity } from "@/lib/activityLog";
import {
  buildAspects,
  ebayAspectNameToSpecificsKey,
  getCategoryAspects,
  MULTI_VALUE_SEPARATOR,
  toItemForEbayPublish,
  verifyListing,
  type CategoryAspect,
} from "@/lib/ebay";
import { prisma } from "@/lib/prisma";
import type { Item, Prisma } from "@/generated/prisma/client";

// The fix agent (Cristian, 2026-11-02): when eBay refuses a publish and
// the quick fixes in publishRemediation.ts come up empty, Claude takes a
// turn at it the way it was done by hand that day. It reads the brand off
// the photos (West Loop sunglasses), copies a value from the same product's
// live listing (iVIZIA's Dosage), checks every change with eBay's free
// verify call, and only hands it back to a person, marked "Needs you",
// when the fix needs someone holding the item.

export type FixAgentResult =
  | { fixed: true; notes: string[] }
  | { fixed: false; needsYou: string; notes: string[] };


const MAX_TURNS = 12;
const MAX_PHOTOS = 4;
const TITLE_MAX = 80;

const SYSTEM = `You fix eBay listings that eBay refused to publish, for a small liquidation resale business. The owner has already reviewed the listing; your job is only to get it past eBay's checks without making anything up.

What you can use:
- The photos (brand names on tags, stickers and packages; labels; directions; sizes).
- The listing's own title, description and item specifics.
- The same product's other listings, when there are any (same UPC). Their values were accepted by eBay and checked by the owner.
- Other listings from the same load in the same category: often the same brand.
- eBay's list of specifics for the category, with allowed values.
- Web search, for facts about this exact product (its label, the maker's page). Only for facts, never for prices.

Rules:
- Never invent or estimate a value. A wrong brand, size or dosage is worse than a listing that waits for a person.
- Strength and active ingredient: only from the label in the photos, the same product's other listing, or the maker's own page.
- Medicines (anything with a Drug Facts or Supplement Facts panel: medicated eye drops, pain relievers, allergy medicine, vitamins): Dosage also only from those three sources, or call needs_a_person.
- Dosage on something that isn't a medicine (wipes, cleansers, contact lens solution, a device): it's how the directions say to use it, like "1 Wipe per Eyelid". The box directions can come from a big retailer's page (Walgreens, CVS, Target, Walmart, Ulta) when it's the exact same product and size, since they reprint the box. If no directions turn up anywhere, "Use as Directed" is true and fine. Don't hand that to a person.
- If no brand appears anywhere (photos, text, the same load), "Unbranded" is eBay's own value for that.
- Department and similar who-is-it-for specifics are a judgment call from the product and the listing's words. If nothing says men or women, use "Unisex Adult".
- Never touch the expiration date, price, quantity, condition, category or photos. If eBay's complaint is about one of those, hand it to the owner.
- Keep text edits small. The title stays true and at most ${TITLE_MAX} characters. For a blocked word, take out the word or the line, don't rewrite the listing.
- eBay reports one error per publish, but check_with_ebay reports every one at once. Fix them all, then check again. Finish only when check_with_ebay passes.
- Call needs_a_person only when the fix truly needs someone with the item in hand or the owner's decision, for example the expiration date, a measurement, a brand that photos and text don't settle between two choices, or a policy problem. Write the reason in one or two plain sentences that say what to do, like "eBay needs the item's length. Measure the box and add it as Item Length."

When check_with_ebay passes, stop and reply with one short line saying what you changed.`;

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "set_item_specific",
    description:
      "Set one item specific, by eBay's exact aspect name (e.g. Brand, Department, Dosage). Replaces any current value. For several values, join them with ' | '.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "eBay's exact aspect name." },
        value: { type: "string" },
        source: {
          type: "string",
          enum: ["photo", "same product listing", "same load", "listing text", "web", "judgment"],
          description: "Where the value came from.",
        },
      },
      required: ["name", "value", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_item_specific",
    description: "Remove one item specific eBay rejects and doesn't require.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "replace_text",
    description:
      "Replace one exact piece of the title or description. `find` must appear exactly once. Use an empty `replace` to delete it.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        field: { type: "string", enum: ["title", "description"] },
        find: { type: "string" },
        replace: { type: "string" },
      },
      required: ["field", "find", "replace"],
      additionalProperties: false,
    },
  },
  {
    name: "check_with_ebay",
    description:
      "Run eBay's free listing check on the listing as it is now. Returns every error eBay would refuse it over, or that it passes. Nothing is published or charged.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "needs_a_person",
    description: "Stop and flag the item for the owner, with what they need to do. Ends your turn.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  { type: "web_search_20260209", name: "web_search", max_uses: 3 },
];

function specificsOf(item: Item): Record<string, string> {
  return (item.itemSpecifics as Record<string, string> | null) ?? {};
}

// The item's specifics under eBay's aspect names, one line each.
function specificsLines(specifics: Record<string, string>): string {
  const aspects = buildAspects(specifics);
  const lines = Object.entries(aspects).map(([name, values]) => `- ${name}: ${values.join(MULTI_VALUE_SEPARATOR)}`);
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

function aspectLine(a: CategoryAspect, has: boolean): string {
  const values = a.values.length > 0 ? `; ${a.selectionOnly ? "only these" : "e.g."}: ${a.values.slice(0, 40).join(", ")}` : "";
  return `- ${a.name}${has ? "" : " (MISSING)"}${a.multi ? " (several allowed)" : ""}${values}`;
}

async function buildPrompt(item: Item, ebayError: string, alreadyTried: string[]): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const specifics = specificsOf(item);
  const have = new Set(Object.keys(buildAspects(specifics)).map((n) => n.toLowerCase()));

  let aspectsText = "(couldn't load them)";
  try {
    const aspects = await getCategoryAspects(item.categoryId!);
    const required = aspects.filter((a) => a.required);
    const recommended = aspects.filter((a) => !a.required && a.recommended).slice(0, 15);
    aspectsText = [
      "Required:",
      ...(required.length > 0 ? required.map((a) => aspectLine(a, have.has(a.name.toLowerCase()))) : ["(none)"]),
      "Recommended (not required):",
      ...recommended.map((a) => `- ${a.name}`),
    ].join("\n");
  } catch (e) {
    console.error(`[fixAgent] ${item.sku}: category aspects failed`, e);
  }

  const sameProduct = item.upc
    ? await prisma.item.findMany({
        where: { upc: item.upc, id: { not: item.id }, ebayListingId: { not: null } },
        select: { sku: true, finalTitle: true, itemSpecifics: true },
        orderBy: { createdAt: "desc" },
        take: 3,
      })
    : [];
  const sameLoad = item.manifestId
    ? await prisma.item.findMany({
        where: { manifestId: item.manifestId, categoryId: item.categoryId, id: { not: item.id }, ebayListingId: { not: null } },
        select: { finalTitle: true, itemSpecifics: true },
        orderBy: { createdAt: "desc" },
        take: 6,
      })
    : [];

  const text = `eBay refused to publish this listing. eBay said: "${ebayError}"
${alreadyTried.length > 0 ? `Already fixed automatically before you: ${alreadyTried.join(" ")}\n` : ""}
SKU: ${item.sku}
Title: ${item.finalTitle}
Category ID: ${item.categoryId}
Condition: ${item.condition}
UPC: ${item.upc ?? "(none)"}
${item.isBundle ? "This is a bundle of several products.\n" : ""}${item.isMultipack ? `Multipack of ${item.packSize ?? "?"}.\n` : ""}Expiration date on file: ${item.expirationDate ? item.expirationDate.toISOString().slice(0, 10) : "none"}

Description:
${item.finalDescription ?? "(none)"}

Item specifics now:
${specificsLines(specifics)}

eBay's specifics for this category:
${aspectsText}

The same product's other listings (same UPC), already accepted by eBay:
${sameProduct.length > 0 ? sameProduct.map((s) => `${s.sku} "${s.finalTitle}"\n${specificsLines((s.itemSpecifics as Record<string, string> | null) ?? {})}`).join("\n\n") : "(none)"}

Other listings from the same load in this category:
${sameLoad.length > 0 ? sameLoad.map((s) => `- "${s.finalTitle}" Brand: ${((s.itemSpecifics as Record<string, string> | null) ?? {}).brand ?? "(none)"}`).join("\n") : "(none)"}

The photos follow. Fix the listing, check it with eBay, and stop when it passes.`;

  const photos = await Promise.all(
    item.photoUrls.slice(0, MAX_PHOTOS).map((url) => fetchImageAsBase64(url).catch(() => null))
  );
  return [
    { type: "text", text },
    ...photos
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ type: "image" as const, source: { type: "base64" as const, media_type: p.mediaType, data: p.data } })),
  ];
}

type ToolOutcome = { content: string; isError?: boolean };

async function runTool(
  itemId: string,
  name: string,
  input: Record<string, string>,
  notes: string[],
  aspects: CategoryAspect[]
): Promise<ToolOutcome> {
  const item = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  const specifics = { ...specificsOf(item) };

  if (name === "set_item_specific") {
    const aspectName = input.name.trim();
    const value = input.value.trim();
    if (/expiration/i.test(aspectName)) {
      return { content: "Never set the expiration date. If eBay needs it, call needs_a_person.", isError: true };
    }
    if (!value) return { content: "Empty value. Use remove_item_specific instead.", isError: true };
    const aspect = aspects.find((a) => a.name.toLowerCase() === aspectName.toLowerCase());
    if (aspect?.selectionOnly && aspect.values.length > 0) {
      const bad = value.split(MULTI_VALUE_SEPARATOR).map((v) => v.trim()).filter((v) => !aspect.values.some((a) => a.toLowerCase() === v.toLowerCase()));
      if (bad.length > 0) return { content: `eBay only accepts these for ${aspect.name}: ${aspect.values.slice(0, 60).join(", ")}`, isError: true };
    }
    if (aspect?.maxLength && value.length > aspect.maxLength) {
      return { content: `${aspect.name} allows at most ${aspect.maxLength} characters.`, isError: true };
    }
    const exactName = aspect?.name ?? aspectName;
    const key = ebayAspectNameToSpecificsKey(exactName);
    // Drop any other spelling of the same aspect so only one is sent.
    for (const k of Object.keys(specifics)) {
      if (k !== key && ebayAspectNameToSpecificsKey(k).toLowerCase() === exactName.toLowerCase()) delete specifics[k];
    }
    const before = specifics[key];
    specifics[key] = value;
    await prisma.item.update({ where: { id: itemId }, data: { itemSpecifics: specifics as Prisma.InputJsonValue } });
    notes.push(before ? `Changed ${exactName} from "${before}" to "${value}" (${input.source}).` : `Added ${exactName}: "${value}" (${input.source}).`);
    return { content: "Saved." };
  }

  if (name === "remove_item_specific") {
    const target = input.name.trim().toLowerCase();
    const keys = Object.keys(specifics).filter(
      (k) => k.toLowerCase() === target || ebayAspectNameToSpecificsKey(input.name.trim()).toLowerCase() === k.toLowerCase()
    );
    if (keys.length === 0) return { content: "The listing doesn't have that specific.", isError: true };
    for (const k of keys) delete specifics[k];
    await prisma.item.update({ where: { id: itemId }, data: { itemSpecifics: specifics as Prisma.InputJsonValue } });
    notes.push(`Removed ${input.name.trim()}.`);
    return { content: "Removed." };
  }

  if (name === "replace_text") {
    const field = input.field === "title" ? "finalTitle" : "finalDescription";
    const current = item[field] ?? "";
    const count = input.find ? current.split(input.find).length - 1 : 0;
    if (count !== 1) {
      return { content: count === 0 ? "That text isn't in it. Copy it exactly." : `That text appears ${count} times. Include more around it.`, isError: true };
    }
    let next = current.replace(input.find, input.replace);
    if (field === "finalDescription") next = next.replace(/\n{3,}/g, "\n\n").replace(/^\s*[-•*]\s*$\n?/gm, "");
    next = field === "finalTitle" ? next.replace(/\s{2,}/g, " ").trim() : next.trim();
    if (field === "finalTitle" && (next.length === 0 || next.length > TITLE_MAX)) {
      return { content: `The title would be ${next.length} characters. It must be 1 to ${TITLE_MAX}.`, isError: true };
    }
    await prisma.item.update({ where: { id: itemId }, data: { [field]: next } });
    const oneLine = (t: string) => t.replace(/\s*\n\s*/g, " / ").trim();
    notes.push(
      input.replace.trim()
        ? `Changed "${oneLine(input.find)}" to "${oneLine(input.replace)}" in the ${input.field}.`
        : `Took "${oneLine(input.find)}" out of the ${input.field}.`
    );
    return { content: "Saved." };
  }

  if (name === "check_with_ebay") {
    const { errors } = await verifyListing(toItemForEbayPublish(item));
    return { content: errors.length === 0 ? "PASSES. eBay would accept it as it is now." : `eBay would refuse it:\n${errors.map((e) => `- ${e}`).join("\n")}` };
  }

  return { content: `Unknown tool ${name}.`, isError: true };
}

// One go at the listing. null when the agent itself couldn't run (API
// error, out of time, a refusal): the caller keeps eBay's own error then.
export async function runFixAgent(
  itemId: string,
  ebayError: string,
  { alreadyTried = [], deadline }: { alreadyTried?: string[]; deadline: number }
): Promise<FixAgentResult | null> {
  const start = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  if (!start.categoryId || !start.finalTitle) return null;
  const notes: string[] = [];
  let needsYou: string | null = null;
  let outOfTime = false;

  try {
    const aspects = await getCategoryAspects(start.categoryId).catch(() => [] as CategoryAspect[]);
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: await buildPrompt(start, ebayError, alreadyTried) },
    ];

    for (let turn = 0; turn < MAX_TURNS && !needsYou; turn++) {
      const left = deadline - Date.now();
      if (left < 15_000) {
        console.log(`[fixAgent] ${start.sku}: out of time after ${turn} turns`);
        outOfTime = true;
        break;
      }
      const response = await anthropic.beta.messages.create(
        {
          model: "claude-opus-5-5",
          max_tokens: 16000,
          system: SYSTEM,
          tools: TOOLS,
          messages,
          output_config: { effort: "medium" },
          cache_control: { type: "ephemeral" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { timeout: Math.min(120_000, left), maxRetries: 1 }
      );
      await logAiUsage("publish.fix_agent", response, { itemId });
      if (response.stop_reason === "refusal") return null;
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const input = block.input as Record<string, string>;
        if (block.name === "needs_a_person") {
          needsYou = (input.reason ?? "").trim() || "The fix agent couldn't fix this one.";
          break;
        }
        let outcome: ToolOutcome;
        try {
          outcome = await runTool(itemId, block.name, input, notes, aspects);
        } catch (e) {
          outcome = { content: `That failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      }
      if (!needsYou) messages.push({ role: "user", content: results });
    }
  } catch (e) {
    console.error(`[fixAgent] ${start.sku}: failed`, e);
    if (notes.length === 0) return null;
  }

  const end = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  if (notes.length > 0) {
    await logActivity(
      { username: "Fix agent" },
      {
        action: "item.fix_agent",
        summary: `Fix agent on ${start.sku}: ${notes.join(" ")}`.slice(0, 500),
        targetType: "item",
        targetId: itemId,
        before: { finalTitle: start.finalTitle, finalDescription: start.finalDescription, itemSpecifics: start.itemSpecifics },
        after: { finalTitle: end.finalTitle, finalDescription: end.finalDescription, itemSpecifics: end.itemSpecifics },
      }
    );
  }
  if (needsYou) return { fixed: false, needsYou, notes };

  // Its own word isn't enough: eBay has to agree.
  const { errors } = await verifyListing(toItemForEbayPublish(end));
  if (errors.length === 0) return notes.length > 0 ? { fixed: true, notes } : null;
  // Cut short, not stuck: the next Publish gives it another go.
  if (outOfTime) return null;
  return {
    fixed: false,
    needsYou: `The fix agent couldn't get this past eBay. eBay still says: ${errors.join(" ")}`,
    notes,
  };
}
