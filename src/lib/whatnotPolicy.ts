import type { EbaySkipReason } from "./ebaySkips";
import { ebayBanReason } from "./ebayBanned";
import { prisma } from "./prisma";
import { linesForKey } from "./productItems";
import { isExactKey } from "./upcMatch";
import { WarehouseError } from "./warehouse/bins";
import { sortedLeft } from "./warehouse/sortCount";

// Can this go on Whatnot? (Cristian, 2026-11-06.) Checked at the listing
// table before a Whatnot listing is made, so anything Whatnot won't allow is
// caught there and set aside for donation, not after photos, review and a
// refused publish. No AI call (Cristian: Whatnot items don't make enough to
// spend API credits on): plain word rules from Whatnot's own policies, read
// 2026-11-06 through the help center's article API
// (help.whatnot.com/api/v2/help_center/en-us/articles/{id}.json; the web
// pages refuse automated reading):
//   360061224972 Prohibited or Restricted Items (updated 2026-11-05):
//     "Medicine and medical devices are not permitted ... prescription
//     drugs, prescription medical devices, ... injectable substances, and
//     over-the-counter medicines"; tobacco, nicotine, e-cigarettes; cannabis
//     and CBD with THC; fireworks; weapons (pepper spray, stun guns, brass
//     knuckles...); sex toys; recalled and expired items. Alcohol is banned
//     too but not matched by name: shade names ("Wine", "Champagne") would
//     block makeup, and liquidation loads don't carry alcohol.
//   11324660673037 Hazardous Materials (2026-11-04): fuel (butane, propane,
//     lamp oil...), paint thinners and removers, strike anywhere matches,
//     flares, mercury, toy gun caps. Aerosols, hand sanitizer, nail polish,
//     fragrances, glue and batteries ARE allowed (special shipping).
//   16920886128653 Cosmetics (2026-10-31): sunscreen, deodorant, shampoo,
//     skincare, fragrance, nail polish are cosmetics: allowed new, sealed,
//     unexpired.
//   41868822998029 Supplements (2026-10-23): only for sellers approved for
//     the Supplements category; no sexual-enhancement supplements; at
//     least 3 months before expiry.
//   27681555378701 Food & Drink (2026-11-05): shelf-stable food is fine
//     sealed, labeled and unexpired; fresh/perishable needs approval.
// Whatnot's rules change; re-read those articles now and then. A word rule
// can be wrong both ways: Cristian can mark a product allowed ("Whatnot
// allows it"), kept as a ResearchObservation kind "whatnot".

const KIND = "whatnot";
// AppSetting: "1" once Whatnot approves the account for Supplements.
export const SUPPLEMENTS_APPROVED_KEY = "whatnot.supplementsApproved";

type Rule = { test: RegExp; not?: RegExp; reason: string };

const OTC_MEDICINE =
  /\b(acetaminophen|ibuprofen|naproxen|aspirin|tylenol|advil|motrin|aleve|excedrin|midol|nyquil|dayquil|zzzquil|mucinex|robitussin|theraflu|vaporub|vicks sinex|unisom|benadryl|diphenhydramine|doxylamine|claritin|loratadine|zyrtec|cetirizine|allegra|fexofenadine|xyzal|levocetirizine|flonase|nasacort|fluticasone|sudafed|pseudoephedrine|phenylephrine|guaifenesin|dextromethorphan|tums|rolaids|pepcid|famotidine|omeprazole|prilosec|nexium|esomeprazole|lansoprazole|prevacid|mylanta|maalox|pepto|bismuth|gas ?x|simethicone|imodium|loperamide|laxative|dulcolax|miralax|senokot|sennosides|colace|docusate|ex ?lax|stool softener|hydrocortisone|cortizone|neosporin|bacitracin|polysporin|lidocaine|benzocaine|orajel|anbesol|icy ?hot|bengay|salonpas|aspercreme|voltaren|diclofenac|clotrimazole|miconazole|terbinafine|lamisil|tolnaftate|monistat|visine|eye drops|ear drops|eye ointment|relief drops|ear ?wax removal|nicorette|dramamine|meclizine|preparation h|minoxidil|rogaine|wart remover|compound w|lice treatment|permethrin|cough drops?|cough syrup|cough suppressant|pain relie(f|ver)|fever reducer|cold (and|&) flu|sinus relief|allergy relief|nasal spray|sleep aid|antacid|anti ?diarrh\w*|antihistamine|decongestant|expectorant)\b/;

const RULES: Rule[] = [
  { test: OTC_MEDICINE, reason: "Whatnot doesn't allow medicine, including over-the-counter medicine." },
  {
    test: /\b(ostomy|colostomy|urostomy|ileostomy|stoma|catheters?|syringes?|lancets?|glucose (meter|monitor|test)|test strips|blood glucose|insulin|pulse oximeter|blood pressure monitor|cpap|hearing aids?|pregnancy tests?|ovulation tests?|contact lens(es)?)\b/,
    not: /\b(contact lens (solution|case|cleaner)|saline|hearing aid batter(y|ies))\b/,
    reason: "Whatnot doesn't allow medical devices or medical supplies.",
  },
  {
    test: /\b(nicotine|vapes?|vaping|e ?cig(arette)?s?|e ?liquids?|juul|cigars?|cigarettes?|chewing tobacco|snuff)\b/,
    not: /\b(lighter|adapter|charger|socket|car plug)\b/,
    reason: "Whatnot doesn't allow tobacco, nicotine or vape products.",
  },
  { test: /\b(cbd|thc|delta ?[89]|cannabis|marijuana)\b/, reason: "Whatnot doesn't allow CBD, THC or cannabis products." },
  {
    test: /\b(male enhancement|sexual enhancement|libido|vibrators?|dildos?|sex toys?|adult toys?)\b/,
    reason: "Whatnot doesn't allow adult or sexual-enhancement products.",
  },
  {
    test: /\b(butane|propane|kerosene|lamp oil|lighter fluid|torch fuel|fuel canisters?|paint thinner|paint remover|paint stripper|mineral spirits|strike anywhere|fireworks?|sparklers?|firecrackers?|road flares?|emergency flares?|toy caps|cap gun caps)\b/,
    reason: "Whatnot doesn't allow fuel, fireworks or other hazardous materials like this.",
  },
  {
    test: /\b(pepper spray|pepper gel|self defense spray|stun guns?|tasers?|brass knuckles|nunchaku?s?|throwing stars?|ninja stars?)\b/,
    reason: "Whatnot doesn't allow weapons like this.",
  },
];

// A supplement is named outright, or a vitamin/collagen/etc. in a pill,
// gummy or powder form. "With Vitamin E" alone is usually makeup.
const SUPPLEMENT =
  /\b(dietary supplements?|multivitamins?|melatonin|probiotics?|fish oil|protein powder|pre ?workout|creatine|ashwagandha|electrolyte powder)\b|\b(vitamins?|supplements?|collagen|biotin|zinc|magnesium|turmeric|elderberry|omega ?3|fiber)\b.*\b(gumm(y|ies)|capsules?|tablets?|softgels?|caplets?|chewables?|powder)\b|\b(gumm(y|ies)|capsules|softgels|tablets|caplets)\b.*\b(vitamins?|supplements?)\b/;

// Vitamin E blush, collagen eye pads: cosmetics, not supplements.
const SKINCARE =
  /\b(shampoo|conditioner|lotion|serum|cream|face|facial|skin|hair|body wash|blush|bronzer|spf|sunscreen|eye pads?|patch(es)?|moisturi[sz]er|mask|lip|makeup|cleanser|toner|nail)\b/;

// Supplier categories that mean medicine or medical supplies.
const CATEGORY_RULE = /\b(over the counter|otc|medicine|medicines|medical supplies)\b/;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
}

export async function supplementsApproved(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: SUPPLEMENTS_APPROVED_KEY } });
  return row?.value === "1";
}

// Why Whatnot won't take it, or null. Pure apart from the supplements
// setting, so publish can run it on the listing's title and category too.
export function whatnotBanReason(name: string, category: string | null, opts: { supplementsOk: boolean }): string | null {
  const n = normalize(name);
  if (ebayBanReason(name)) return "Whatnot doesn't allow prescription items or medical devices.";
  for (const rule of RULES) {
    if (rule.test.test(n) && !(rule.not && rule.not.test(n))) return rule.reason;
  }
  if (category && CATEGORY_RULE.test(normalize(category))) {
    return "Whatnot doesn't allow medicine or medical supplies.";
  }
  // By eBay category too (2026-11-06: "HALLS Vitamin C Drops" and "Vitex
  // Fruit 400mg Vegan Capsules" got past the wording; their category says
  // Vitamins & Lifestyle Supplements).
  if (!opts.supplementsOk && ((SUPPLEMENT.test(n) && !SKINCARE.test(n)) || SUPPLEMENT_CATEGORY.test(category ?? ""))) {
    return "Whatnot only lets approved sellers sell supplements and vitamins, and this account isn't approved.";
  }
  return null;
}

// Supplements need 3 months left at the time of order; everything else
// has to reach the buyer before its date, and a Whatnot show can be weeks
// after listing.
// eBay categories that are supplements whatever the title says.
const SUPPLEMENT_CATEGORY = /Vitamins & Lifestyle Supplements|Sports Nutrition/i;

// category: the eBay category path, when known (supplements by category get
// Whatnot's 90 days too).
export function whatnotDaysNeeded(name: string, category?: string | null): number {
  return SUPPLEMENT.test(normalize(name)) || SUPPLEMENT_CATEGORY.test(category ?? "") ? 90 : 30;
}

export type WhatnotVerdict = {
  allowed: boolean;
  // Plain words for the person at the table, null when allowed.
  reason: string | null;
  // The product as the check saw it.
  name: string;
  // Expiration dates closer than this many days aren't allowed.
  minDaysToExpiry: number;
};

function descriptionKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);
}

// The best name on file for a scanned code: the load's manifest line,
// what the sorter called it, or an earlier listing of it.
async function productName(code: string, manifestId: string | null): Promise<{ name: string; category: string | null }> {
  if (manifestId) {
    const lines = isExactKey(code)
      ? await linesForKey(manifestId, code)
      : await prisma.manifestLine.findMany({ where: { manifestId, upc: code }, select: { description: true, category: true }, take: 1 });
    if (lines[0]?.description) return { name: lines[0].description, category: lines[0].category ?? null };
  }
  if (!isExactKey(code)) {
    const line = await prisma.manifestLine.findFirst({
      where: { upc: code },
      orderBy: { manifest: { createdAt: "desc" } },
      select: { description: true, category: true },
    });
    if (line?.description) return { name: line.description, category: line.category ?? null };
  }
  const sorted = await prisma.sortBoxEntry.findFirst({
    where: { upc: code, name: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { name: true },
  });
  if (sorted?.name) return { name: sorted.name, category: null };
  const item = await prisma.item.findFirst({
    where: { upc: code, finalTitle: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { finalTitle: true },
  });
  return { name: item?.finalTitle ?? `UPC ${code}`, category: null };
}

export async function allowedByOwner(code: string, name: string): Promise<boolean> {
  const found = await prisma.researchObservation.findFirst({
    where: { kind: KIND, verdict: "ALLOWED", ...(isExactKey(code) ? { descriptionKey: descriptionKey(name) } : { upc: code }) },
    select: { id: true },
  });
  return Boolean(found);
}

export async function checkWhatnot(code: string, manifestId: string | null): Promise<WhatnotVerdict> {
  const { name, category } = await productName(code, manifestId);
  const minDaysToExpiry = whatnotDaysNeeded(name);
  const reason = whatnotBanReason(name, category, { supplementsOk: await supplementsApproved() });
  if (!reason || (await allowedByOwner(code, name))) return { allowed: true, reason: null, name, minDaysToExpiry };
  return { allowed: false, reason, name, minDaysToExpiry };
}

// Cristian: "Whatnot allows it" on a block. Kept, so the next scan of it
// goes straight through.
export async function overrideWhatnot(code: string, manifestId: string | null, by: string): Promise<void> {
  const { name } = await productName(code, manifestId);
  const now = new Date();
  await prisma.researchObservation.create({
    data: {
      kind: KIND,
      upc: isExactKey(code) ? null : code,
      descriptionKey: descriptionKey(name),
      description: name.slice(0, 500),
      verdict: "ALLOWED",
      note: `Allowed by ${by}`,
      searched: false,
      basisAt: now,
    },
  });
}

// Units Whatnot won't take, set aside for donation (Cristian: "we will mark
// it as donated for now"). On a sorted load they were counted as good in a
// sort box, so they're a listing-table set-aside like the pack card's
// (setAsideReason), no more than what's left; otherwise a plain dud. Both
// already decided: donate. No manifest = nothing to record against.
export async function recordWhatnotDonation(args: {
  code: string;
  manifestId: string;
  quantity: number;
  reason: string;
  // The pack card's why when it came from "List it for Whatnot".
  why: EbaySkipReason | null;
  by: string | null;
}): Promise<void> {
  if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 10000) {
    throw new WarehouseError("Enter how many, at least 1.");
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`set_aside|${args.manifestId}`}))`;
    const left = await sortedLeft(args.manifestId, args.code);
    if (left && args.quantity > left.left) {
      throw new WarehouseError(
        left.left === 0
          ? "Every unit of this product is already listed or set aside."
          : `Only ${left.left} of this product ${left.left === 1 ? "is" : "are"} left, not ${args.quantity}.`,
        409
      );
    }
    await tx.manifestDudEntry.create({
      data: {
        manifestId: args.manifestId,
        upc: args.code,
        quantity: args.quantity,
        note: `Not allowed on Whatnot: ${args.reason}`.slice(0, 500),
        recordedBy: args.by,
        setAsideReason: left ? (args.why ?? "whatnot_banned") : null,
        decision: "donate",
        decidedBy: args.by,
        decidedAt: new Date(),
      },
    });
  });
}
