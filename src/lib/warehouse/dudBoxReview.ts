import type { Prisma } from "@/generated/prisma/client";
import { shopChannelWorth, type ListingWorth } from "../packSize";
import { prisma } from "../prisma";
import { getShopifyPricing, shopifyPriceFor, type ShopifyPricing } from "../shopifySync";
import { upcMatchKeys } from "../upcMatch";
import { WarehouseError } from "./bins";
import { findDudBox } from "./dudBoxes";
import type { DudBoxDetail, DudBoxEntry, DudBoxStatus, DudBoxSummary, DudDecision, DudMoneyHint } from "./dudBoxTypes";
import { DUD_ESTIMATE_SELECT, dudCall, latestCompleteEvaluationId, type DudEstimate } from "./sortCheck";
import type { CodeLabelPayload } from "./types";

// Everything the dud box APIs do past creating a box (createDudBox) and
// listing from one (claimDudUnits): the sorter adding to it, closing it,
// deciding each product, and the box finishing on its own. Server only.
//
// Lock order, shared with claimDudUnits: the DudBox row first (when a
// status could change), then the box's ManifestDudEntry rows. claimDudUnits
// only takes the entry rows, so the two can't wait on each other.

type Tx = Prisma.TransactionClient;

// What prints under the barcode: which load the duds came from, so nobody
// has to write it on the box. Long BStock titles get cut; the label shows
// up to two small lines.
const CAPTION_MAX = 48;

export function dudBoxLabelPayload(code: string, manifestTitle: string): CodeLabelPayload {
  const title = manifestTitle.replace(/\s+/g, " ").trim();
  const caption = `DUDS · ${title}`;
  return { code, caption: caption.length > CAPTION_MAX ? `${caption.slice(0, CAPTION_MAX - 1).trimEnd()}…` : caption };
}

type EntryState = { quantity: number; listedUnits: number; decision: string | null };

// Done = something in it, every product decided, and every Shopify unit
// listed. An empty box stays where it is (nothing to process, and it was
// probably closed by mistake).
export function dudBoxFinished(entries: EntryState[]): boolean {
  return (
    entries.length > 0 &&
    entries.every((e) => e.decision != null && (e.decision !== "shopify" || e.listedUnits >= e.quantity))
  );
}

// Moves a closed box to done when it's finished, and a done box back to
// closed when it isn't anymore (a decision changed to Shopify, say). An
// open box is left alone: the sorter may still be adding to it.
function settledStatus(status: string, entries: EntryState[]): DudBoxStatus {
  if (status === "open") return "open";
  return dudBoxFinished(entries) ? "done" : "closed";
}

async function settleInTx(tx: Tx, box: { id: string; status: string }): Promise<DudBoxStatus> {
  const entries = await tx.manifestDudEntry.findMany({
    where: { dudBoxId: box.id },
    select: { quantity: true, listedUnits: true, decision: true },
  });
  const next = settledStatus(box.status, entries);
  if (next !== box.status) {
    await tx.dudBox.update({
      where: { id: box.id },
      data: { status: next, doneAt: next === "done" ? new Date() : null },
    });
  }
  return next;
}

// For the listing side (POST /api/items after claimDudUnits): call inside
// the same transaction so the box flips to done the moment its last
// Shopify unit is listed. The dud box GET routes also catch up on their
// own, so a box never stays wrong for long if this isn't called.
export async function settleDudBox(tx: Tx, boxId: string): Promise<DudBoxStatus> {
  const box = await tx.dudBox.findUnique({ where: { id: boxId }, select: { id: true, status: true } });
  if (!box) throw new WarehouseError("That dud box doesn't exist anymore.", 404);
  return await settleInTx(tx, box);
}

async function lockBox(tx: Tx, rawCode: string) {
  const found = await findDudBox(tx, rawCode);
  await tx.$executeRaw`SELECT id FROM "DudBox" WHERE id = ${found.id} FOR UPDATE`;
  // Re-read under the lock: the status may have changed while waiting.
  return tx.dudBox.findUniqueOrThrow({ where: { id: found.id } });
}

// The sort station putting units into a box. Only an open box of the same
// load takes them, so a box never mixes loads or gets added to after it's
// been processed.
export async function addDudEntry(args: {
  code: string;
  manifestId: string;
  upc: string;
  quantity: number;
  note: string | null;
  by: string | null;
}) {
  if (!args.upc) throw new WarehouseError("UPC is required.");
  if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 10000) {
    throw new WarehouseError("Quantity must be a whole number, at least 1.");
  }
  return prisma.$transaction(async (tx) => {
    const box = await lockBox(tx, args.code);
    if (box.manifestId !== args.manifestId) {
      throw new WarehouseError(`Dud box ${box.code} is for a different load. Start a dud box for this one.`, 409);
    }
    if (box.status !== "open") {
      throw new WarehouseError(
        `Dud box ${box.code} is ${box.status === "done" ? "already processed" : "closed"}. Start a new dud box.`,
        409
      );
    }
    const entry = await tx.manifestDudEntry.create({
      data: {
        manifestId: box.manifestId,
        dudBoxId: box.id,
        upc: args.upc,
        quantity: args.quantity,
        note: args.note,
        recordedBy: args.by,
      },
    });
    const units = await tx.manifestDudEntry.aggregate({ where: { dudBoxId: box.id }, _sum: { quantity: true } });
    return { entry, box: { code: box.code, status: box.status, units: units._sum.quantity ?? 0 } };
  });
}

// Close (full, ready to process) or reopen. Done is never set by hand: a
// closed box becomes done on its own once it's finished.
export async function setDudBoxStatus(code: string, status: "open" | "closed") {
  return prisma.$transaction(async (tx) => {
    const box = await lockBox(tx, code);
    if (status === "open") {
      if (box.status !== "open") {
        await tx.dudBox.update({ where: { id: box.id }, data: { status: "open", closedAt: null, doneAt: null } });
      }
      return { code: box.code, status: "open" as DudBoxStatus };
    }
    if (box.status === "open") {
      await tx.dudBox.update({ where: { id: box.id }, data: { status: "closed", closedAt: new Date() } });
    }
    const next = await settleInTx(tx, { id: box.id, status: box.status === "open" ? "closed" : box.status });
    return { code: box.code, status: next };
  });
}

// Decide one or more entries (the box page groups a product's entries and
// decides them together). Changing a decision is fine until units have
// been listed from it: those are real Items now, so it has to stay Shopify.
// decision null = back to undecided, same rule.
export async function decideDudEntries(args: {
  code: string;
  entryIds: string[];
  decision: DudDecision | null;
  by: string | null;
}) {
  const ids = [...new Set(args.entryIds)];
  if (ids.length === 0) throw new WarehouseError("Pick a product to decide.");
  return prisma.$transaction(async (tx) => {
    const box = await lockBox(tx, args.code);
    await tx.$executeRaw`SELECT id FROM "ManifestDudEntry" WHERE "dudBoxId" = ${box.id} FOR UPDATE`;
    const entries = await tx.manifestDudEntry.findMany({ where: { id: { in: ids }, dudBoxId: box.id } });
    if (entries.length !== ids.length) {
      throw new WarehouseError(`That product isn't in dud box ${box.code} anymore. Reload the box.`, 404);
    }
    const listed = entries.reduce((sum, e) => sum + e.listedUnits, 0);
    if (args.decision !== "shopify" && listed > 0) {
      throw new WarehouseError(
        `${listed} of these ${listed === 1 ? "is" : "are"} already listed from this box, so it has to stay Shopify.`,
        409
      );
    }
    await tx.manifestDudEntry.updateMany({
      where: { id: { in: ids } },
      data: {
        decision: args.decision,
        decidedBy: args.decision ? args.by : null,
        decidedAt: args.decision ? new Date() : null,
      },
    });
    const status = await settleInTx(tx, box);
    return { code: box.code, status };
  });
}

// Owner-only money hint for one unit (see DudMoneyHint). estimatedNetPerUnit
// is zeroed on a dud, so the net is worked out again from the price parts.
// The Shopify side reuses the pack card's Shopify/Whatnot math
// (shopifyPriceFor + shopChannelWorth) with no item cost, so it's the same
// price rule and fee assumptions.
function moneyHint(e: DudEstimate | null, pricing: ShopifyPricing | null, retail: number | null): DudMoneyHint | null {
  if (!e) return null;
  const price = e.estimatedUnitSalePrice != null ? Number(e.estimatedUnitSalePrice) : 0;
  if (price <= 0) return { ebayPrice: null, ebayNet: null, shopNet: null };
  const fees = Number(e.estimatedUnitFees ?? 0);
  const shipping = Number(e.estimatedUnitShipping ?? 0);
  const asEbay: ListingWorth = {
    worthIt: false,
    price,
    label: shipping,
    itemCost: null,
    profit: price - fees - shipping,
    returnPct: null,
    requiredProfit: 0,
  };
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    ebayPrice: round(price),
    ebayNet: round(price - fees - shipping),
    shopNet: pricing ? round(shopChannelWorth(asEbay, shopifyPriceFor(price, price, retail, pricing)).profit) : null,
  };
}

// Index the newest finished Analyzer run's estimates by loose UPC key, so
// an entry stored with a slightly different barcode still finds its call.
function estimateIndex(estimates: DudEstimate[]) {
  const byKey = new Map<string, DudEstimate>();
  for (const e of estimates) for (const k of upcMatchKeys(e.upc)) if (!byKey.has(k)) byKey.set(k, e);
  return (upc: string) => {
    for (const k of upcMatchKeys(upc)) {
      const hit = byKey.get(k);
      if (hit) return hit;
    }
    return null;
  };
}

export async function getDudBoxDetail(rawCode: string, isOwner: boolean): Promise<DudBoxDetail> {
  const found = await findDudBox(prisma, rawCode);
  // Catch up on listing done since the last look (see settleDudBox).
  await prisma.$transaction((tx) => settleInTx(tx, found));

  const [box, entries, lines, evaluationId] = await Promise.all([
    prisma.dudBox.findUniqueOrThrow({ where: { id: found.id }, include: { manifest: { select: { title: true } } } }),
    prisma.manifestDudEntry.findMany({ where: { dudBoxId: found.id }, orderBy: { createdAt: "asc" } }),
    prisma.manifestLine.findMany({ where: { manifestId: found.manifestId }, select: { upc: true, description: true, retailPrice: true } }),
    latestCompleteEvaluationId(found.manifestId),
  ]);
  const [estimates, pricing] = await Promise.all([
    evaluationId
      ? prisma.sourcingLineEstimate.findMany({ where: { evaluationId }, select: DUD_ESTIMATE_SELECT })
      : Promise.resolve([] as DudEstimate[]),
    isOwner ? getShopifyPricing() : Promise.resolve(null),
  ]);
  const findEstimate = estimateIndex(estimates);
  const lineByKey = new Map<string, (typeof lines)[number]>();
  for (const l of lines) for (const k of upcMatchKeys(l.upc)) if (!lineByKey.has(k)) lineByKey.set(k, l);
  const lineFor = (upc: string) => {
    for (const k of upcMatchKeys(upc)) {
      const l = lineByKey.get(k);
      if (l) return l;
    }
    return null;
  };

  const shaped: DudBoxEntry[] = entries.map((e) => {
    const estimate = findEstimate(e.upc);
    const line = lineFor(e.upc);
    const description = line?.description ?? estimate?.description ?? `UPC ${e.upc}`;
    const call = dudCall({ description, evaluated: evaluationId != null, estimate });
    // Not flagged by anything: the sorter put it in the box on their own.
    const dudReason = call.dud
      ? call.reason!
      : `The sorter's call${call.reason ? ` (${call.reason.charAt(0).toLowerCase()}${call.reason.slice(1)})` : ""}`;
    return {
      id: e.id,
      upc: e.upc,
      description,
      quantity: e.quantity,
      listedUnits: e.listedUnits,
      decision: (e.decision as DudDecision | null) ?? null,
      decidedBy: e.decidedBy,
      decidedAt: e.decidedAt?.toISOString() ?? null,
      dudReason,
      note: e.note,
      recordedBy: e.recordedBy,
      createdAt: e.createdAt.toISOString(),
      ...(isOwner ? { money: moneyHint(estimate, pricing, line && Number(line.retailPrice) > 0 ? Number(line.retailPrice) : null) } : {}),
    };
  });

  return {
    box: {
      code: box.code,
      status: box.status as DudBoxStatus,
      manifestId: box.manifestId,
      manifestTitle: box.manifest.title,
      createdBy: box.createdBy,
      createdAt: box.createdAt.toISOString(),
      closedAt: box.closedAt?.toISOString() ?? null,
      doneAt: box.doneAt?.toISOString() ?? null,
    },
    entries: shaped,
  };
}

// Every dud box (optionally by status / load), newest first. Few enough
// boxes that the list is built in one go; boxes whose listing finished
// since the last look are settled on the way (see settleDudBox).
export async function listDudBoxes(filter: {
  statuses: DudBoxStatus[] | null;
  manifestId: string | null;
}): Promise<DudBoxSummary[]> {
  const boxes = await prisma.dudBox.findMany({
    where: filter.manifestId ? { manifestId: filter.manifestId } : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      manifest: { select: { title: true } },
      entries: { select: { quantity: true, listedUnits: true, decision: true } },
    },
  });
  const changed = boxes.filter((b) => settledStatus(b.status, b.entries) !== b.status);
  if (changed.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const b of changed) b.status = await settleInTx(tx, b);
    });
  }
  return boxes
    .filter((b) => !filter.statuses || filter.statuses.includes(b.status as DudBoxStatus))
    .map((b) => {
      const shopify = b.entries.filter((e) => e.decision === "shopify");
      return {
        code: b.code,
        status: b.status as DudBoxStatus,
        manifestId: b.manifestId,
        manifestTitle: b.manifest.title,
        entryCount: b.entries.length,
        undecided: b.entries.filter((e) => e.decision == null).length,
        units: b.entries.reduce((sum, e) => sum + e.quantity, 0),
        shopifyUnits: shopify.reduce((sum, e) => sum + e.quantity, 0),
        listedUnits: shopify.reduce((sum, e) => sum + Math.min(e.listedUnits, e.quantity), 0),
        createdBy: b.createdBy,
        createdAt: b.createdAt.toISOString(),
        closedAt: b.closedAt?.toISOString() ?? null,
        doneAt: b.doneAt?.toISOString() ?? null,
      };
    });
}
