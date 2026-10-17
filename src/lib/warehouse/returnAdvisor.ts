import { anthropic } from "../anthropic";
import { logAiUsage } from "../aiUsage";
import { FALLBACK_FEE_FIXED, FALLBACK_FEE_RATE } from "../packSize";
import { typicalSingleLabelCost } from "../shippingCost";
import { labelForWeight } from "../shippingZone";
import { getTargetMarginPct } from "../sourcingAgent";
import {
  decisionFits,
  describePlan,
  LIST_CONDITIONS,
  NOT_SAME_DECISIONS,
  planProblem,
  type ConditionReport,
  type ReturnDecisionNotSame,
  type ReturnListCondition,
  type ReturnPlan,
} from "./returnPlan";

// Return agent: a customer return that ISN'T in the same brand-new shape
// (missing pieces, opened, used, damaged) gets a call on what to do with
// it, the way Cristian would make it. The call is a plan for every PHYSICAL
// unit that came back (a returned 3-pack is 3 units): how many get listed
// and in what pack size, how many get thrown out, donated, or were missing.
// Cristian's example: a 3-pack comes back with one unit damaged, so the 2
// good ones go up as a 2-pack and the damaged one is thrown out. The main
// decision is what happens to the listable part (relist_new / shopify_only),
// or dispose / donate when nothing gets listed. Code supplies the numbers;
// the model weighs them against his rules. The employee sees only a plain
// reason with no money in it (employees never see money); the owner also
// gets the money reasoning. adviseReturnFallback is the rules-only answer
// when the call fails or comes back unusable.

export {
  decisionFits,
  describePlan,
  LIST_CONDITIONS,
  NOT_SAME_DECISIONS,
  planProblem,
  type ConditionReport,
  type ReturnDecisionNotSame,
  type ReturnListCondition,
  type ReturnPlan,
} from "./returnPlan";

export type ReturnAdvice = {
  decision: ReturnDecisionNotSame;
  condition: ReturnListCondition | null;
  plan: ReturnPlan;
  // For the employee: plain, no money, says what to do with each part.
  reason: string;
  // For the owner only: the money side of the call.
  ownerReason: string | null;
  basis: "agent" | "fallback";
};

export type ReturnAdviceInput = {
  title: string;
  categoryPath: string | null;
  condition: string | null;
  // Physical units in one listing unit of the original (its pack size, 1
  // for a single or a bundle).
  perUnit: number;
  expirationDate: Date | null;
  // The listing's price (eBay-equivalent) per listing unit, if priced.
  price: number | null;
  // What one physical unit cost Cristian, if known.
  unitCost: number | null;
  weightLbs: number | null;
  // Physical units that came back.
  returnedUnits: number;
  report: ConditionReport;
};

// Medicine, sunscreen (FDA regulates it as a drug), baby formula / food and
// food in general: once opened it's never resold.
const NEVER_RESELL_OPENED =
  /Over-the-Counter|Medicat|Vitamin|Supplement|Sunscreen|Sun Care|Baby Formula|Baby Food|Food|Grocery|Snack|Beverage|Candy/i;

// Whatnot's published seller fees (8% commission, 2.9% + $0.30 processing),
// same figures as src/lib/shopifySync.ts.
const WHATNOT_FEE_RATE = 0.109;
const WHATNOT_FEE_PER_ORDER = 0.3;

const money = (n: number) => `$${n.toFixed(2)}`;
function isExpired(date: Date | null): boolean {
  return date != null && date.getTime() < Date.now();
}

// The units the report says are here, and how many of those are damaged.
function counts(input: ReturnAdviceInput) {
  const r = input.report;
  const here = r.missingUnits && r.unitsHere != null ? Math.max(0, Math.min(input.returnedUnits, r.unitsHere)) : input.returnedUnits;
  const damaged = r.damaged ? Math.max(0, Math.min(here, r.damagedUnits ?? here)) : 0;
  return { here, missing: input.returnedUnits - here, damaged };
}

// The rest of a multi-pack goes back up as one pack of what's left (a
// single when it's one), separate singles stay singles. Same shape the
// expiry relist uses (src/lib/relist.ts).
function packFor(perUnit: number, units: number): number {
  return perUnit > 1 && units > 1 ? units : 1;
}

// Rules only, no model: what the agent would most likely say, for when the
// call fails. Errs toward not reselling anything risky.
export function adviseReturnFallback(input: ReturnAdviceInput): ReturnAdvice {
  const r = input.report;
  const { here, missing, damaged } = counts(input);
  const sensitive = NEVER_RESELL_OPENED.test(`${input.categoryPath ?? ""} ${input.title}`);
  const base = { ownerReason: null, basis: "fallback" as const };
  const plan = (list: number, thrown: number): ReturnPlan => ({
    returnedUnits: input.returnedUnits,
    listUnits: list,
    listPackSize: packFor(input.perUnit, list),
    thrownUnits: thrown,
    donateUnits: 0,
    missingUnits: missing,
  });
  const done = (decision: ReturnDecisionNotSame, condition: ReturnListCondition | null, p: ReturnPlan, why: string): ReturnAdvice => ({
    ...base,
    decision,
    condition,
    plan: p,
    reason: [...describePlan(p, decision), why].join(" ").trim(),
  });

  if (here === 0) return done("dispose", null, plan(0, 0), "Nothing came back to list.");
  if (sensitive && (r.opened || r.used || r.damaged)) {
    return done("dispose", null, plan(0, here), "It's medicine, sunscreen, baby food or food that's been opened, so it can't be resold.");
  }
  if (isExpired(input.expirationDate)) return done("dispose", null, plan(0, here), "It's past its date, so it can't be resold.");
  // Some damaged, some fine: the damaged ones go, the rest get listed.
  if (damaged > 0 && damaged < here) {
    const condition: ReturnListCondition = r.used ? "used" : r.opened || input.perUnit > 1 ? "new_other" : "new";
    return done(r.used ? "shopify_only" : "relist_new", condition, plan(here - damaged, damaged), "");
  }
  if (damaged > 0) {
    return done(
      "shopify_only",
      r.opened || r.used ? "for_parts" : "new_other",
      plan(here, 0),
      "It's damaged, so it goes on Shopify & Whatnot at a lower price."
    );
  }
  if (r.used) return done("shopify_only", "used", plan(here, 0), "It's used, so it goes on Shopify & Whatnot.");
  return done("relist_new", "new_other", plan(here, 0), missing > 0 ? "" : "Opened but complete, so it goes up as open box.");
}

export async function adviseReturn(input: ReturnAdviceInput): Promise<ReturnAdvice> {
  const fallback = adviseReturnFallback(input);
  const [typicalLabel, targetMarginPct] = await Promise.all([typicalSingleLabelCost(), getTargetMarginPct()]);
  const label = input.weightLbs != null ? labelForWeight(typicalLabel, input.weightLbs) : typicalLabel;
  const { here, missing, damaged } = counts(input);
  const r = input.report;
  const conditionLines = [
    missing > 0 ? `Missing: ${missing} of the ${input.returnedUnits} units are not in the box (${here} here)` : null,
    r.opened ? "Opened: yes" : null,
    r.used ? "Used: yes" : null,
    r.damaged ? `Damaged: ${damaged} of the ${here} units here` : null,
    r.note ? `Staff note: "${r.note}"` : null,
    r.photoUrls.length > 0 ? `${r.photoUrls.length} photo(s) taken of the damage (not shown to you)` : null,
  ].filter(Boolean);

  const prompt = `A customer returned an item to Cristian's liquidation resale business. Decide what happens to every unit that came back.

ITEM
Title: ${input.title}
Category: ${input.categoryPath ?? "unknown"}
Listed condition: ${input.condition ?? "unknown"}
${input.perUnit > 1 ? `Sold as a ${input.perUnit}-pack (${input.perUnit} units per listing)` : "Sold as singles"}
Expiration: ${input.expirationDate ? input.expirationDate.toISOString().slice(0, 10) : "none"}${isExpired(input.expirationDate) ? " (ALREADY EXPIRED)" : ""}
Units (pieces) that came back: ${input.returnedUnits}

CONDITION REPORT (from the employee holding it)
${conditionLines.join("\n") || "Not the same as new, no details given"}

MONEY
Listed price when new, per listing (${input.perUnit} unit${input.perUnit === 1 ? "" : "s"}): ${input.price != null ? money(input.price) : "unknown"}
Cost per unit: ${input.unitCost != null ? money(input.unitCost) : "unknown"}
eBay fees: about ${(FALLBACK_FEE_RATE * 100).toFixed(2)}% + ${money(FALLBACK_FEE_FIXED)}; seller pays the label, about ${money(label)}.
Shopify & Whatnot: buyer pays shipping; Whatnot fees ${(WHATNOT_FEE_RATE * 100).toFixed(1)}% + ${money(WHATNOT_FEE_PER_ORDER)}.

CRISTIAN'S RULES
- Target margin is ${targetMarginPct}% on what's left after fees and label.
- If an eBay sale can't pay for the label (price in this condition minus fees minus label is too thin), it goes Shopify & Whatnot only.
- OTC medicine, sunscreen, baby formula / baby food, or any food that has been opened: throw it out. Never resell.
- Expired: throw out medicine, sunscreen and baby formula/food. Other expired goods may go Shopify & Whatnot only if clearly usable; otherwise throw out.
- Donate units that are usable but not worth listing anywhere.
- Units that are fine can still be sold even when others in the same return are damaged: e.g. a 3-pack with one damaged unit becomes the 2 good ones listed as a 2-pack, and the damaged one thrown out.
- Used or opened items sell for less: estimate the price in the real condition (open box roughly 70-85% of new, used roughly 40-60%, for parts roughly 15-30%).

THE PLAN (all counts are units/pieces, and they must add up to exactly ${input.returnedUnits})
- listUnits: units to list again; listPackSize: units per listing (1 = separate singles; e.g. 2 units as one 2-pack = listPackSize 2). listUnits must divide evenly by listPackSize. 0 and 1 when nothing is listed.
- thrownUnits: damaged or unusable units thrown out.
- donateUnits: usable units donated.
- missingUnits: units not in the box (exactly ${missing} per the report).
decision: what happens to the listed part: relist_new (new eBay listing in its real condition) or shopify_only (Shopify & Whatnot only). If nothing is listed: dispose, or donate when the units left are donated.
condition (only when something is listed): new (sealed, untouched), new_other (open box, complete, unused), used, for_parts. null when nothing is listed.
reason: short plain sentences for the employee that say what to do with each part (e.g. "List the 2 good ones as a 2-pack. Throw out the damaged one."), NO dollar amounts, NO numbers about money or margin.
ownerReason: the money reasoning for Cristian, with the numbers.`;

  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-sonnet-5",
        max_tokens: 1500,
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                decision: { type: "string", enum: NOT_SAME_DECISIONS },
                condition: { type: ["string", "null"], enum: [...LIST_CONDITIONS, null] },
                listUnits: { type: "integer" },
                listPackSize: { type: "integer" },
                thrownUnits: { type: "integer" },
                donateUnits: { type: "integer" },
                missingUnits: { type: "integer" },
                reason: { type: "string" },
                ownerReason: { type: "string" },
              },
              required: [
                "decision",
                "condition",
                "listUnits",
                "listPackSize",
                "thrownUnits",
                "donateUnits",
                "missingUnits",
                "reason",
                "ownerReason",
              ],
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: 30_000, maxRetries: 0 }
    );
    await logAiUsage("return.advice", response);
    const text = response.content.find((b) => b.type === "text");
    const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as Record<string, unknown>;
    return normalizeAdvice(parsed, input.returnedUnits, fallback);
  } catch (e) {
    console.error("[returnAdvisor] falling back to rules", e);
    return fallback;
  }
}

// Keeps the model's answer inside the allowed shapes: a plan that doesn't
// add up, or a decision that doesn't fit it, means the rules answer
// instead. Money that slipped into the employee's reason is replaced with
// the plain plan.
export function normalizeAdvice(parsed: Record<string, unknown>, returnedUnits: number, fallback: ReturnAdvice): ReturnAdvice {
  const listUnits = Number(parsed.listUnits);
  const plan: ReturnPlan = {
    returnedUnits,
    listUnits,
    listPackSize: listUnits === 0 ? 1 : Number(parsed.listPackSize),
    thrownUnits: Number(parsed.thrownUnits),
    donateUnits: Number(parsed.donateUnits),
    missingUnits: Number(parsed.missingUnits),
  };
  const decision = parsed.decision as ReturnDecisionNotSame;
  if (planProblem(plan) || !NOT_SAME_DECISIONS.includes(decision) || !decisionFits(decision, plan)) {
    return { ...fallback, ownerReason: typeof parsed.ownerReason === "string" ? parsed.ownerReason : null };
  }
  const condition =
    plan.listUnits > 0
      ? LIST_CONDITIONS.includes(parsed.condition as ReturnListCondition)
        ? (parsed.condition as ReturnListCondition)
        : (fallback.condition ?? "used")
      : null;
  let reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (!reason || /\$\s?\d|\d+(\.\d+)?\s?%|margin|profit/i.test(reason)) reason = describePlan(plan, decision).join(" ");
  return {
    decision,
    condition,
    plan,
    reason,
    ownerReason: typeof parsed.ownerReason === "string" && parsed.ownerReason.trim() ? parsed.ownerReason.trim() : null,
    basis: "agent",
  };
}
