import type { Item, Prisma } from "@/generated/prisma/client";
import { unitCostForScan } from "../cogs";
import { prisma } from "../prisma";
import { inheritedFields } from "../relist";
import { adjustItemStock } from "../stockAdjust";
import { upcMatchKeys } from "../upcMatch";
import { nextItemCode, WarehouseError } from "./bins";
import { classifyScan, normalizeCode } from "./codes";
import { buildItemLabel, queueItemLabels } from "./itemLabel";
import {
  adviseReturnFallback,
  decisionFits,
  describePlan,
  NOT_SAME_DECISIONS,
  planProblem,
  type ConditionReport,
  type ReturnAdvice,
  type ReturnAdviceInput,
  type ReturnDecisionNotSame,
  type ReturnListCondition,
  type ReturnPlan,
} from "./returnAdvisor";
import { RETURN_NOTE_DONATED, RETURN_NOTE_MISSING, RETURN_NOTE_THROWN } from "./returnReconcile";

// Returns mode (/returns): a customer sent something back. Same brand-new
// condition = it goes back on its listing if that's still live
// ("add_back"), or onto a fresh copy of the listing if it sold out or ended
// ("relist_same"; a listing is never revived, Cristian's never-restock rule
// and eBay's). Not the same = the return agent's call (returnAdvisor.ts):
// a new listing in its real condition (relist_new, finished on the scan
// page at /scan?return={id}), Shopify & Whatnot only, dispose or donate.
// Every return is an ItemReturn row with the decision and the reason.

export type ReturnDecision = "add_back" | "relist_same" | ReturnDecisionNotSame;

export type ListingState = "live" | "sold_out" | "ended";

// Still taking orders: listed, not ended by the sold-out sweep, not pulled
// for its date. A sold-out listing that eBay keeps alive (out-of-stock
// control) still counts as live: the unit goes straight back on it.
export function listingState(item: Item): ListingState {
  const onAChannel = Boolean(item.ebayOfferId || item.ebayListingId || item.shopifyOnly);
  if (item.status === "listed" && onAChannel && !item.listingEndedAt && !item.expiredAt) return "live";
  return item.soldQuantity >= item.quantity ? "sold_out" : "ended";
}

export type ReturnSale = {
  channel: "ebay" | "shopify" | "whatnot" | "in_person" | string;
  orderId: string | null;
  // What to show: "eBay order 12-34567-89012", "Shopify #1042".
  label: string;
  quantity: number;
  soldAt: string;
};

// What the returns page shows for one candidate listing. No money: the
// page is used by employees.
export type ReturnCandidate = {
  id: string;
  sku: string;
  title: string;
  photoUrl: string | null;
  upc: string | null;
  isBundle: boolean;
  isMultipack: boolean;
  packSize: number | null;
  condition: string | null;
  expirationDate: string | null;
  quantity: number;
  soldQuantity: number;
  available: number;
  shopifyOnly: boolean;
  listing: ListingState;
  sales: ReturnSale[];
};

const SALES_PER_ITEM = 8;
const UPC_CANDIDATES = 10;

export function itemTitle(item: Pick<Item, "finalTitle" | "aiTitle" | "sku" | "upc">): string {
  return item.finalTitle ?? item.aiTitle ?? (item.upc ? `UPC ${item.upc}` : item.sku);
}

async function salesFor(itemIds: string[]): Promise<Map<string, ReturnSale[]>> {
  const [ebay, shopify, inPerson] = await Promise.all([
    prisma.ebayItemSale.findMany({
      where: { itemId: { in: itemIds } },
      orderBy: { soldAt: "desc" },
      select: { itemId: true, ebayOrderId: true, quantity: true, soldAt: true },
    }),
    prisma.shopifySale.findMany({
      where: { itemId: { in: itemIds } },
      orderBy: { soldAt: "desc" },
      select: { itemId: true, shopifyOrderId: true, shopifyOrderName: true, channel: true, quantity: true, soldAt: true },
    }),
    prisma.inPersonSale.findMany({
      where: { itemId: { in: itemIds } },
      orderBy: { soldAt: "desc" },
      select: { itemId: true, id: true, quantity: true, soldAt: true },
    }),
  ]);
  const map = new Map<string, ReturnSale[]>();
  const add = (itemId: string, sale: ReturnSale) => map.set(itemId, [...(map.get(itemId) ?? []), sale]);
  for (const s of ebay) {
    add(s.itemId, { channel: "ebay", orderId: s.ebayOrderId, label: `eBay order ${s.ebayOrderId}`, quantity: s.quantity, soldAt: s.soldAt.toISOString() });
  }
  for (const s of shopify) {
    const where = s.channel === "whatnot" ? "Whatnot" : s.channel === "shopify" ? "Shopify" : s.channel;
    add(s.itemId, {
      channel: s.channel,
      orderId: s.shopifyOrderName || s.shopifyOrderId,
      label: `${where} ${s.shopifyOrderName}`,
      quantity: s.quantity,
      soldAt: s.soldAt.toISOString(),
    });
  }
  for (const s of inPerson) {
    add(s.itemId, { channel: "in_person", orderId: null, label: "In-person sale", quantity: s.quantity, soldAt: s.soldAt.toISOString() });
  }
  for (const [id, list] of map) {
    map.set(id, list.sort((a, b) => b.soldAt.localeCompare(a.soldAt)).slice(0, SALES_PER_ITEM));
  }
  return map;
}

function toCandidate(item: Item, sales: ReturnSale[]): ReturnCandidate {
  return {
    id: item.id,
    sku: item.sku,
    title: itemTitle(item),
    photoUrl: item.photoUrls[0] ?? null,
    upc: item.upc,
    isBundle: item.isBundle,
    isMultipack: item.isMultipack,
    packSize: item.packSize,
    condition: item.condition,
    expirationDate: item.expirationDate ? item.expirationDate.toISOString().slice(0, 10) : null,
    quantity: item.quantity,
    soldQuantity: item.soldQuantity,
    available: Math.max(0, item.quantity - item.soldQuantity),
    shopifyOnly: item.shopifyOnly,
    listing: listingState(item),
    sales,
  };
}

// The listing(s) a scanned return could be. An item label (ES code) is one
// exact listing. Older items have no label, so their UPC finds the
// listings of it that have sold something, most recent sale first.
export async function findReturnCandidates(rawCode: string): Promise<ReturnCandidate[]> {
  const code = normalizeCode(rawCode);
  if (!code) return [];
  const kind = classifyScan(code);
  let items: Item[];
  if (kind === "item") {
    const item = await prisma.item.findUnique({ where: { sku: code } });
    items = item ? [item] : [];
  } else if (kind === "upc") {
    // Loose match: the stored UPC can have dropped or extra leading zeros.
    const digits = code.replace(/^0+/, "");
    const variants = [...new Set([code, digits, `0${digits}`, `00${digits}`])];
    const keys = new Set(upcMatchKeys(code));
    items = (
      await prisma.item.findMany({
        where: { upc: { in: variants }, soldQuantity: { gt: 0 } },
        orderBy: { updatedAt: "desc" },
        take: 50,
      })
    ).filter((i) => upcMatchKeys(i.upc).some((k) => keys.has(k)));
  } else {
    throw new WarehouseError(`${code} isn't an item label or a UPC. Scan the ES label, or the UPC on the package.`);
  }
  if (items.length === 0) return [];
  const sales = await salesFor(items.map((i) => i.id));
  return items
    .map((i) => toCandidate(i, sales.get(i.id) ?? []))
    .sort((a, b) => (b.sales[0]?.soldAt ?? "").localeCompare(a.sales[0]?.soldAt ?? ""))
    .slice(0, UPC_CANDIDATES);
}

// Physical units in one listing unit: a 3-pack is 3, a single or a whole
// bundle is 1.
export function perUnitOf(item: Pick<Item, "isMultipack" | "packSize">): number {
  return item.isMultipack && item.packSize ? item.packSize : 1;
}

export async function adviceInputFor(item: Item, unitsBack: number, report: ConditionReport): Promise<ReturnAdviceInput> {
  const [category, unitCost] = await Promise.all([
    item.categoryId ? prisma.ebayCategory.findUnique({ where: { id: item.categoryId }, select: { path: true } }) : null,
    item.manifestId && item.upc ? unitCostForScan(item.manifestId, item.upc).catch(() => null) : null,
  ]);
  const weightLbs =
    item.weightLbs != null || item.weightOz != null ? (item.weightLbs ?? 0) + (item.weightOz ?? 0) / 16 : null;
  return {
    title: itemTitle(item),
    categoryPath: category?.path ?? null,
    condition: item.condition,
    perUnit: perUnitOf(item),
    expirationDate: item.expirationDate,
    price: item.originalPrice != null ? Number(item.originalPrice) : item.price != null ? Number(item.price) : null,
    unitCost,
    weightLbs,
    returnedUnits: unitsBack * perUnitOf(item),
    report,
  };
}

export function parseReport(raw: unknown): ConditionReport {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const count = (v: unknown) => {
    const n = Number(v);
    return v !== null && v !== "" && v !== undefined && Number.isInteger(n) && n >= 0 ? n : null;
  };
  return {
    missingUnits: r.missingUnits === true,
    opened: r.opened === true,
    used: r.used === true,
    damaged: r.damaged === true,
    unitsHere: r.missingUnits === true ? count(r.unitsHere) : null,
    damagedUnits: r.damaged === true ? count(r.damagedUnits) : null,
    note: typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 500) : null,
    photoUrls: Array.isArray(r.photoUrls) ? r.photoUrls.filter((u): u is string => typeof u === "string").slice(0, 12) : [],
  };
}

// The condition a new listing of a not-the-same return goes up as, when the
// agent didn't say (an override, or a fallback with no condition).
export function conditionFromReport(report: ConditionReport): ReturnListCondition {
  if (report.used) return "used";
  if (report.damaged && (report.damagedUnits == null || report.opened)) return "for_parts";
  return "new_other";
}

// What ItemReturn.report holds: the employee's report plus the agent's call
// and what was actually done, so the new listing, the manifest numbers and
// the owner's view can read it back.
export type StoredReturnReport = ConditionReport & {
  advice?: ReturnAdvice | null;
  overridden?: boolean;
  // Where every returned physical unit went (same-condition returns too).
  plan?: ReturnPlan;
  // relist_new / shopify_only: the condition to list as.
  listCondition?: ReturnListCondition | null;
  // Units written onto the original's manifest as damaged (thrown out +
  // missing) and dud (donated) when the return was saved. 0 when the item
  // has no manifest. returnReconcile.ts takes these back off received.
  leftoverEntries?: { damaged: number; dud: number };
  // Older rows (before plans): listing units to list.
  listUnits?: number | null;
};

export type RecordReturnInput = {
  itemId: string;
  channel: string | null;
  orderId: string | null;
  units: number;
  sameCondition: boolean;
  // Not the same condition: what to do with the listable part (the agent's
  // call or an override).
  decision?: string | null;
  report?: unknown;
  // The employee's own split when they changed the agent's: { listUnits,
  // listPackSize, thrownUnits, donateUnits, missingUnits } in physical
  // units. Left out = the agent's plan (or the rules' plan).
  plan?: unknown;
  // The pending row POST /api/returns/advice saved with the agent's call.
  // The advice is read from there, never from the client, so the owner's
  // money reasoning is kept even when an employee made the call, and an
  // override can't pretend to be the agent's.
  adviceId?: string | null;
  stationId?: string | null;
  by: string | null;
};

// Decision of a row the advice route saved and nobody finished yet.
export const PENDING_DECISION = "pending";

// Saves (or updates) the agent's call as a pending ItemReturn, so it's
// kept server-side with the owner's reasoning until the employee picks
// what to do. Returns its id.
export async function savePendingAdvice(args: {
  adviceId?: string | null;
  itemId: string;
  channel: string | null;
  orderId: string | null;
  units: number;
  report: ConditionReport;
  advice: ReturnAdvice;
  by: string | null;
}): Promise<string> {
  const data = {
    itemId: args.itemId,
    channel: args.channel?.trim() || null,
    orderId: args.orderId?.trim() || null,
    units: args.units,
    sameCondition: false,
    report: { ...args.report, advice: args.advice } as unknown as Prisma.InputJsonValue,
    decision: PENDING_DECISION,
    reason: args.advice.reason,
    recordedBy: args.by,
  };
  if (args.adviceId) {
    const updated = await prisma.itemReturn.updateMany({
      where: { id: args.adviceId, itemId: args.itemId, decision: PENDING_DECISION },
      data,
    });
    if (updated.count === 1) return args.adviceId;
  }
  return (await prisma.itemReturn.create({ data })).id;
}

export type RecordReturnResult = {
  returnId: string;
  decision: ReturnDecision;
  item: { id: string; sku: string };
  // relist_same: the new listing.
  newItem?: { id: string; sku: string } | null;
  labelsQueued?: number;
  // add_back: labels to reprint for the units put back (they need bagging).
  units: number;
  plan: ReturnPlan;
};

function parsePlan(raw: unknown, returnedUnits: number): ReturnPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const listUnits = Number(r.listUnits);
  return {
    returnedUnits,
    listUnits,
    listPackSize: listUnits === 0 ? 1 : Number(r.listPackSize),
    thrownUnits: Number(r.thrownUnits ?? 0),
    donateUnits: Number(r.donateUnits ?? 0),
    missingUnits: Number(r.missingUnits ?? 0),
  };
}

const samePlan = (a: ReturnPlan, b: ReturnPlan) =>
  a.listUnits === b.listUnits &&
  (a.listUnits === 0 || a.listPackSize === b.listPackSize) &&
  a.thrownUnits === b.thrownUnits &&
  a.donateUnits === b.donateUnits &&
  a.missingUnits === b.missingUnits;

// The units of a return that won't be listed, written onto the original's
// manifest so its numbers stay true: thrown out and missing as damaged,
// donated as dud (no dud box). Same UPC as the original. Nothing for an
// item with no manifest or no single UPC (a bundle).
async function recordLeftovers(
  tx: Prisma.TransactionClient,
  item: Item,
  plan: ReturnPlan,
  by: string | null
): Promise<{ damaged: number; dud: number }> {
  if (!item.manifestId || !item.upc || item.isBundle) return { damaged: 0, dud: 0 };
  const base = { manifestId: item.manifestId, upc: item.upc, recordedBy: by };
  if (plan.thrownUnits > 0) {
    await tx.manifestDamagedEntry.create({ data: { ...base, quantity: plan.thrownUnits, note: RETURN_NOTE_THROWN } });
  }
  if (plan.missingUnits > 0) {
    await tx.manifestDamagedEntry.create({ data: { ...base, quantity: plan.missingUnits, note: RETURN_NOTE_MISSING } });
  }
  if (plan.donateUnits > 0) {
    await tx.manifestDudEntry.create({ data: { ...base, quantity: plan.donateUnits, note: RETURN_NOTE_DONATED } });
  }
  return { damaged: plan.thrownUnits + plan.missingUnits, dud: plan.donateUnits };
}

export async function recordReturn(input: RecordReturnInput): Promise<RecordReturnResult> {
  const units = Number(input.units);
  if (!Number.isInteger(units) || units < 1 || units > 500) throw new WarehouseError("How many came back has to be a whole number, at least 1.");
  const item = await prisma.item.findUnique({ where: { id: input.itemId } });
  if (!item) throw new WarehouseError("That listing doesn't exist anymore.", 404);
  const channel = input.channel?.trim() || null;
  const orderId = input.orderId?.trim() || null;
  const base = { itemId: item.id, channel, orderId, units, recordedBy: input.by };
  const perUnit = perUnitOf(item);
  const returnedUnits = units * perUnit;
  // Same condition: every unit goes back up, in the original's shape.
  const wholePlan: ReturnPlan = {
    returnedUnits,
    listUnits: returnedUnits,
    listPackSize: perUnit,
    thrownUnits: 0,
    donateUnits: 0,
    missingUnits: 0,
  };
  const wholeReport = { plan: wholePlan } as unknown as Prisma.InputJsonValue;

  if (input.sameCondition) {
    if (listingState(item) === "live") {
      // Back on the same listing, the way a stock edit does it (live eBay
      // check, push, StockAdjustment). If eBay refuses, nothing is recorded
      // as a return, so it can just be tried again.
      const adjusted = await adjustItemStock({
        itemId: item.id,
        direction: "add",
        amount: units,
        note: orderId ? `Return from order ${orderId}` : "Customer return",
        recordedBy: input.by,
      });
      if (!adjusted.ok) throw new WarehouseError(adjusted.error, adjusted.status);
      const row = await prisma.itemReturn.create({
        data: {
          ...base,
          sameCondition: true,
          decision: "add_back",
          reason: "Same condition, listing still live: added back.",
          report: wholeReport,
        },
      });
      return { returnId: row.id, decision: "add_back", item: { id: item.id, sku: item.sku }, units, plan: wholePlan };
    }
    // Sold out or ended: a fresh copy, never the old listing.
    const stationId = input.stationId ?? "";
    if (!stationId) throw new WarehouseError("Pick a station first, so the new labels print there.");
    const station = await prisma.station.findUnique({ where: { id: stationId }, select: { id: true } });
    if (!station) throw new WarehouseError("That station doesn't exist anymore. Pick a station again.", 404);
    const label = await buildItemLabel(prisma, { ...item, sku: "" });
    const { row, created, labelsQueued } = await prisma.$transaction(
      async (tx) => {
        const created = await tx.item.create({ data: await sameConditionCopy(tx, item, units, input.by) });
        const labelsQueued = await queueItemLabels(tx, {
          stationId,
          payload: { ...label, code: created.sku },
          copies: units,
          by: input.by,
        });
        const row = await tx.itemReturn.create({
          data: {
            ...base,
            sameCondition: true,
            decision: "relist_same",
            reason: "Same condition, listing sold out or ended: new copy of the listing.",
            newItemId: created.id,
            report: wholeReport,
          },
        });
        return { row, created, labelsQueued };
      },
      { maxWait: 10_000, timeout: 20_000 }
    );
    return {
      returnId: row.id,
      decision: "relist_same",
      item: { id: item.id, sku: item.sku },
      newItem: { id: created.id, sku: created.sku },
      labelsQueued,
      units,
      plan: wholePlan,
    };
  }

  const decision = input.decision as ReturnDecisionNotSame;
  if (!NOT_SAME_DECISIONS.includes(decision)) throw new WarehouseError("Pick what to do with it.");
  const report = parseReport(input.report);
  const pending = input.adviceId
    ? await prisma.itemReturn.findFirst({ where: { id: input.adviceId, itemId: item.id, decision: PENDING_DECISION } })
    : null;
  if (input.adviceId && !pending) throw new WarehouseError("That return was already recorded. Start over to do another.");
  const storedAdvice = (pending?.report as StoredReturnReport | null)?.advice ?? null;
  // Advice for a different count (asked, then the count changed) doesn't
  // fit this return.
  const advice =
    storedAdvice && NOT_SAME_DECISIONS.includes(storedAdvice.decision) && storedAdvice.plan?.returnedUnits === returnedUnits
      ? storedAdvice
      : null;

  const plan =
    parsePlan(input.plan, returnedUnits) ??
    advice?.plan ??
    adviseReturnFallback(await adviceInputFor(item, units, report)).plan;
  const problem = planProblem(plan);
  if (problem) throw new WarehouseError(problem);
  if (!decisionFits(decision, plan)) {
    throw new WarehouseError(
      plan.listUnits > 0
        ? "Some units are being listed, so pick eBay or Shopify & Whatnot for them."
        : decision === "donate"
          ? "Nothing is marked to donate. Throw it out instead, or change the counts."
          : "Nothing is being listed, so pick throw out or donate."
    );
  }
  const lists = decision === "relist_new" || decision === "shopify_only";
  const overridden = advice != null && (advice.decision !== decision || !samePlan(advice.plan, plan));
  const listCondition = lists ? (advice?.condition ?? conditionFromReport(report)) : null;
  const reason = overridden || !advice
    ? [...describePlan(plan, decision), ...(overridden ? ["Staff changed the suggested plan."] : [])].join(" ")
    : advice.reason;

  const returnId = await prisma.$transaction(
    async (tx) => {
      // Leftovers first, so the stored report says exactly what was written.
      const leftoverEntries = await recordLeftovers(tx, item, plan, input.by);
      const stored: StoredReturnReport = { ...report, advice, overridden, plan, listCondition, leftoverEntries };
      const data = {
        ...base,
        sameCondition: false,
        report: stored as unknown as Prisma.InputJsonValue,
        decision,
        reason,
      };
      if (pending) {
        // Only while still pending, so a double tap can't record it twice
        // (the throw rolls the leftover entries back too).
        const updated = await tx.itemReturn.updateMany({ where: { id: pending.id, decision: PENDING_DECISION }, data });
        if (updated.count === 0) throw new WarehouseError("That return was already recorded. Start over to do another.");
        return pending.id;
      }
      return (await tx.itemReturn.create({ data })).id;
    },
    { maxWait: 10_000, timeout: 20_000 }
  );
  return { returnId, decision, item: { id: item.id, sku: item.sku }, units, plan };
}

// A new listing that's the old one again: same text, photos, category,
// condition, specifics and price, a new item code, units = what came back.
// The undiscounted price, since a fresh listing shouldn't start with the old
// one's markdown (the price review shows it anyway). Goes to review like
// any new item.
async function sameConditionCopy(
  tx: Prisma.TransactionClient,
  original: Item,
  units: number,
  by: string | null
): Promise<Prisma.ItemUncheckedCreateInput> {
  return {
    sku: await nextItemCode(tx),
    upc: original.upc,
    quantity: units,
    isMultipack: original.isMultipack,
    packSize: original.packSize,
    expirationDate: original.expirationDate,
    shelfLocation: "",
    photoUrls: original.photoUrls,
    scannedBy: by,
    isBundle: original.isBundle,
    bundleComponents: (original.bundleComponents ?? undefined) as Prisma.InputJsonValue | undefined,
    upcLookupData: (original.upcLookupData ?? undefined) as Prisma.InputJsonValue | undefined,
    countPerPackage: original.countPerPackage,
    aiTitle: original.aiTitle,
    aiDescription: original.aiDescription,
    finalTitle: original.finalTitle,
    finalDescription: original.finalDescription,
    price: original.originalPrice ?? original.price,
    localPickupOnly: original.localPickupOnly,
    shopifyOnly: original.shopifyOnly,
    chargeForShipping: original.chargeForShipping,
    boxSize: original.boxSize,
    weightLbs: original.weightLbs,
    weightOz: original.weightOz,
    manifestId: original.manifestId,
    ...inheritedFields(original),
    // Same date as before, so the specific stays.
    itemSpecifics: (original.itemSpecifics ?? undefined) as Prisma.InputJsonValue | undefined,
  };
}

// For the scan page's /scan?return={id}: what to prefill. Only for a
// not-the-same return that should be listed and isn't yet. The pack shape
// is the plan's (the 2 good units of a returned 3-pack = quantity 1 of a
// 2-pack), not the original's.
export type ReturnListingPlan = {
  id: string;
  decision: "relist_new" | "shopify_only";
  title: string;
  upc: string | null;
  manifestId: string | null;
  isMultipack: boolean;
  packSize: number | null;
  quantity: number;
  condition: ReturnListCondition;
  expirationDate: string | null;
  boxSize: string | null;
  // Plain summary for the banner: "Opened, missing pieces".
  summary: string;
  // What to do with each part, for the banner.
  steps: string[];
};

export function describeReport(report: ConditionReport): string {
  const parts = [
    report.missingUnits ? "missing units or pieces" : null,
    report.opened ? "opened" : null,
    report.used ? "used" : null,
    report.damaged ? "damaged" : null,
  ].filter(Boolean) as string[];
  const text = parts.length > 0 ? parts.join(", ") : "not like new";
  return text[0].toUpperCase() + text.slice(1);
}

export async function returnListingPlan(returnId: string): Promise<ReturnListingPlan> {
  const row = await prisma.itemReturn.findUnique({ where: { id: returnId }, include: { item: true } });
  if (!row) throw new WarehouseError("That return doesn't exist.", 404);
  if (row.decision !== "relist_new" && row.decision !== "shopify_only") {
    throw new WarehouseError("That return isn't waiting to be listed.");
  }
  if (row.newItemId) throw new WarehouseError("That return was already listed.");
  const report = (row.report ?? {}) as StoredReturnReport;
  const original = row.item;
  const plan = report.plan;
  const shape = plan
    ? {
        quantity: plan.listUnits / plan.listPackSize,
        isMultipack: plan.listPackSize > 1,
        packSize: plan.listPackSize > 1 ? plan.listPackSize : null,
      }
    : { quantity: report.listUnits ?? row.units, isMultipack: original.isMultipack, packSize: original.packSize };
  return {
    id: row.id,
    decision: row.decision,
    title: itemTitle(original),
    upc: original.upc,
    manifestId: original.manifestId,
    ...shape,
    condition: report.listCondition ?? conditionFromReport(parseReport(report)),
    expirationDate: original.expirationDate ? original.expirationDate.toISOString().slice(0, 10) : null,
    boxSize: original.boxSize,
    summary: describeReport(parseReport(report)),
    steps: plan ? describePlan(plan, row.decision) : [],
  };
}

// The staff note for the AI draft of a return's new listing, so its
// description says what's actually wrong with it (src/lib/draftItem.ts).
export async function returnDraftNote(newItemId: string): Promise<string | null> {
  const row = await prisma.itemReturn.findFirst({ where: { newItemId, sameCondition: false } });
  if (!row) return null;
  const report = parseReport(row.report);
  const stored = (row.report ?? {}) as StoredReturnReport;
  const plan = stored.plan;
  const lines = [
    `This is a customer return being listed again in its real condition (${stored.listCondition ?? "see photos"}), not new stock.`,
    `Staff report: ${describeReport(report).toLowerCase()}.`,
    plan && plan.listUnits < plan.returnedUnits
      ? `Only ${plan.listUnits} of the ${plan.returnedUnits} returned units are in this listing (the rest were damaged, missing or donated); describe exactly what's included.`
      : null,
    report.note ? `Staff note: "${report.note}"` : null,
    "Say plainly in the description what's missing, opened, used or damaged, so the buyer knows exactly what they get. Don't call it new or sealed unless every unit in it is.",
  ].filter(Boolean);
  return lines.join("\n");
}
