// The shapes of a return's plan, and the checks on it. Safe to import from
// client components (the returns page shows and edits plans): no server
// imports here. See returnAdvisor.ts for how a plan is made.

export type ReturnDecisionNotSame = "relist_new" | "shopify_only" | "dispose" | "donate";
export const NOT_SAME_DECISIONS: ReturnDecisionNotSame[] = ["relist_new", "shopify_only", "dispose", "donate"];
export type ReturnListCondition = "new" | "new_other" | "used" | "for_parts";
export const LIST_CONDITIONS: ReturnListCondition[] = ["new", "new_other", "used", "for_parts"];

// All counts are physical units (pieces), never listing units.
export type ConditionReport = {
  missingUnits: boolean;
  opened: boolean;
  used: boolean;
  damaged: boolean;
  // Units actually here, when some are missing.
  unitsHere: number | null;
  // How many of the units here are damaged (null = all of them).
  damagedUnits: number | null;
  note: string | null;
  photoUrls: string[];
};

// Where every returned physical unit goes. listUnits are listed as
// listUnits / listPackSize listings of listPackSize each (1 = singles).
// The four parts always add up to returnedUnits.
export type ReturnPlan = {
  returnedUnits: number;
  listUnits: number;
  listPackSize: number;
  thrownUnits: number;
  donateUnits: number;
  missingUnits: number;
};

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

// Why a plan can't be used, or null when it's fine.
export function planProblem(plan: ReturnPlan): string | null {
  const parts = [plan.listUnits, plan.listPackSize, plan.thrownUnits, plan.donateUnits, plan.missingUnits];
  if (!parts.every(isInt) || parts.some((n) => n < 0)) return "Every count has to be a whole number, 0 or more.";
  if (plan.listPackSize < 1) return "Pack size has to be at least 1.";
  const sum = plan.listUnits + plan.thrownUnits + plan.donateUnits + plan.missingUnits;
  if (sum !== plan.returnedUnits) {
    return `Those add up to ${sum}, but ${plan.returnedUnits} came back. Every unit has to go somewhere.`;
  }
  if (plan.listUnits % plan.listPackSize !== 0) return `${plan.listUnits} units can't be split into packs of ${plan.listPackSize}.`;
  return null;
}

// What the plan's main action is, when the listable part decides it:
// listing something means relist_new / shopify_only; listing nothing means
// dispose, or donate when everything left is donated.
export function decisionFits(decision: ReturnDecisionNotSame, plan: ReturnPlan): boolean {
  const lists = decision === "relist_new" || decision === "shopify_only";
  if (plan.listUnits > 0) return lists;
  if (lists) return false;
  return decision === "donate" ? plan.donateUnits > 0 : true;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "List the 2 as one 2-pack", "Throw out 1", ... for the employee.
export function describePlan(plan: ReturnPlan, decision?: ReturnDecisionNotSame): string[] {
  const parts: string[] = [];
  if (plan.listUnits > 0) {
    const where = decision === "shopify_only" ? " on Shopify & Whatnot" : "";
    const listings = plan.listUnits / plan.listPackSize;
    parts.push(
      plan.listPackSize === 1
        ? `List ${plan.listUnits === 1 ? "it" : `the ${plan.listUnits}`} as ${plural(plan.listUnits, "single")}${where}.`
        : listings === 1
          ? `List the ${plan.listUnits} good ones as one ${plan.listPackSize}-pack${where}.`
          : `List the ${plan.listUnits} good ones as ${listings} ${plan.listPackSize}-packs${where}.`
    );
  }
  if (plan.thrownUnits > 0) parts.push(`Throw out ${plan.thrownUnits === 1 ? "the damaged one" : `${plan.thrownUnits} of them`}.`);
  if (plan.donateUnits > 0) parts.push(`Donate ${plan.donateUnits === 1 ? "1" : plan.donateUnits}.`);
  if (plan.missingUnits > 0) parts.push(`${plural(plan.missingUnits, "unit")} ${plan.missingUnits === 1 ? "was" : "were"} missing from the box.`);
  return parts;
}

